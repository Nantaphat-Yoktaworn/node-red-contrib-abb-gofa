MODULE MainModuleEGM

    ! -------------------------------------------------------
    ! ABB GoFa CRB 15000 - Socket command server + EGM mode
    !
    ! This is a clone of MainModule.mod (same TCP command server --
    ! HOME/GOTO/jog/GETVAR/SETVAR/SETDO/etc, byte-identical logic) with
    ! one addition: an "EGMJOINT" command that switches the task into a
    ! blocking EGM (Externally Guided Motion) UDP streaming session, then
    ! falls back to serving TCP commands when that session ends.
    !
    ! MainModule.mod itself is untouched and stays the default/known-good
    ! module -- load THIS one only when a flow needs the gofa-egm node.
    ! Loading either module is a plain gofa-upload-mod + gofa-rapid-exec
    ! (loadmod/resetpp/start) operation; see CLAUDE.md for the two-module
    ! setup and the one-time UDPUC ("EGM_PC") controller config required
    ! before EGM will connect to anything.
    !
    ! Protocol (newline-terminated, case-insensitive):
    !   HOME -> rGoHome      P1 -> rPickPos1
    !   P2   -> rPickPos2    P3 -> rPlacePos
    !   EGMJOINT -> ack OK:EGMJOINT, then this task stops serving TCP and
    !               blocks in an EGM joint-streaming session (see
    !               RunEgmJoint below) until gofa-egm.js sets
    !               ABB_Scalable_IO_0_DO16 via RWS to request a graceful
    !               stop (TrapEgmStop/EGMStop), at which point TCP serving
    !               resumes automatically -- see RunEgmJoint below.
    ! Reply: "OK:<CMD>\n" (or "ERR:<CMD>\n" for unknown command)
    !
    ! No RWS mastership / no program-pointer handling needed:
    ! launch once in AUTO + Motors On, then the website drives
    ! it indefinitely. Add a point = one CASE + one routine.
    !
    ! pHome     = robot's position at time of setup
    ! pPickPos1 = pHome +200mm in X  (right)
    ! pPickPos2 = pHome -200mm in X  (left)
    ! pPlacePos = pHome +200mm in Y  (forward)
    ! All points within 200mm of home (safe 300mm limit)
    ! -------------------------------------------------------

    PERS tooldata tGripper := [TRUE, [[0,0,0],[1,0,0,0]], [1,[0,0,100],[1,0,0,0],0,0,0]];
    PERS wobjdata wobj1    := [FALSE, TRUE, "", [[0,0,0],[1,0,0,0]], [[0,0,0],[1,0,0,0]]];
    PERS zonedata zActive  := [FALSE, 10, 15, 15, 1.5, 15, 1.5];
    PERS bool bStopMotion  := FALSE;

    ! Test variables for RAPID Var Read / Write nodes
    ! Task: T_ROB1  Module: MainModuleEGM
    PERS num    nTestVar := 0;
    PERS string sTestMsg := "hello";

    ! Home = position robot was at during setup
    PERS robtarget pHome     := [[323.21,-81.81,807.00],
                                  [0.2671,0.1290,0.9536,-0.0528],
                                  [-1,-1,0,0],
                                  [9E9,9E9,9E9,9E9,9E9,9E9]];

    ! Pick Pos 1: +200mm in X from home (reach right)
    PERS robtarget pPickPos1 := [[523.21,-81.81,807.00],
                                  [0.2671,0.1290,0.9536,-0.0528],
                                  [-1,-1,0,0],
                                  [9E9,9E9,9E9,9E9,9E9,9E9]];

    ! Pick Pos 2: -200mm in X from home (reach left)
    PERS robtarget pPickPos2 := [[123.21,-81.81,807.00],
                                  [0.2671,0.1290,0.9536,-0.0528],
                                  [-1,-1,0,0],
                                  [9E9,9E9,9E9,9E9,9E9,9E9]];

    ! Place Pos: +200mm in Y from home (reach forward)
    PERS robtarget pPlacePos := [[323.21,118.19,807.00],
                                  [0.2671,0.1290,0.9536,-0.0528],
                                  [-1,-1,0,0],
                                  [9E9,9E9,9E9,9E9,9E9,9E9]];

    ! -------------------------------------------------------
    ! Socket server state
    ! -------------------------------------------------------
    CONST string SERVER_IP   := "192.168.20.33";
    CONST num    SERVER_PORT  := 1025;

    ! Persisted home pose (survives restart AND module reload). One line of
    ! 11 ;-separated numbers, same layout as a GOTO token, written by SETHOME.
    CONST string HOME_FILE   := "HOME:/Programs/gofa_home.cfg";

    ! Jog: slow + predictable. Clamps below are the safety knobs.
    CONST speeddata vJog     := [50, 500, 5000, 1000];
    CONST num    JOG_MAX_MM  := 50;
    CONST num    JOG_MAX_DEG := 30;
    CONST num    JOINT_MAX_DEG := 30;   ! per-axis jog clamp

    ! GoTo a saved point: moderate speed (operator watches the cell).
    CONST speeddata vGoto    := [100, 500, 5000, 1000];

    VAR socketdev serverSocket;
    VAR socketdev clientSocket;
    VAR string    rxStr;

    ! -------------------------------------------------------
    ! EGM mode state
    ! -------------------------------------------------------
    ! Set TRUE by Dispatch on "EGMJOINT"; checked after ServeClient/
    ! ServeForever return so the TCP sockets unwind cleanly before main()
    ! runs the blocking EGM session.
    VAR bool      bEgmRequested := FALSE;
    VAR egmident  egmID1;
    VAR egmstate  egmSt1;
    ! Hard position-correction envelope in degrees -- RobotWare clamps any
    ! commanded offset to within this window of the joint's nominal
    ! trajectory. NOT a tracking tolerance. Must stay bigger than whatever
    ! amplitude gofa-egm ever asks for, or the joint holds still no matter
    ! what target is sent, with no error anywhere (confirmed the hard way
    ! in gofa-egm-python at +/-0.001 -- widened to +/-10.0 there).
    CONST egm_minmax egm_minmax1 := [-10.0, 10.0];

    ! Interrupt used to gracefully end an EGM session from inside the task
    ! (see RunEgmJoint / TrapEgmStop below) -- ABB_Scalable_IO_0_DO16 is
    ! reserved as the "please stop EGM now" trigger gofa-egm.js sets via
    ! RWS. Confirmed live it already has Access:All, no RobotStudio change
    ! needed. If this signal is ever needed for something else, move this
    ! to a different spare DO and update gofa-egm.js's STOP_SIGNAL to match.
    VAR intnum egmStopIntNo;

    ! -------------------------------------------------------
    ! MAIN - go home, then serve forever. Any socket fault
    ! tears the server down and rebuilds it (robust to a
    ! Node-RED restart or a dropped connection). An EGMJOINT
    ! command instead runs one EGM session, then loops back
    ! to serving TCP commands.
    ! -------------------------------------------------------
    PROC main()
        LoadHome;
        WHILE TRUE DO
            ServeForever;
            IF bEgmRequested THEN
                ! Clear the flag BEFORE running, not after: RunEgmJoint can be
                ! cut off by an external RWS stop (confirmed live -- EGM's own
                ! \CommTimeout does not reliably end a session with no client
                ! replying, so a forced stop is the real recovery path, not a
                ! fallback). A stop does not run RunEgmJoint's own cleanup, so
                ! clearing the flag here is the only place guaranteed to run
                ! before the next resetpp+start -- otherwise the stale TRUE
                ! flag would immediately kick the very next TCP command straight
                ! back into another blocking EGM session instead of serving it.
                bEgmRequested := FALSE;
                RunEgmJoint;
            ELSE
                WaitTime 1;
            ENDIF
        ENDWHILE
    ENDPROC

    PROC ServeForever()
        SocketCreate serverSocket;
        SocketBind serverSocket, SERVER_IP, SERVER_PORT;
        SocketListen serverSocket;
        WHILE TRUE DO
            ! Wait (indefinitely) for the website to connect
            SocketAccept serverSocket, clientSocket \Time:=WAIT_MAX;
            ServeClient;
            IF bEgmRequested THEN
                ! EGMJOINT received -- close the listening socket so TCP
                ! clients get a fast "connection refused" during the EGM
                ! session instead of hanging, then return to main().
                SocketClose serverSocket;
                RETURN;
            ENDIF
        ENDWHILE
    ERROR
        ! Any socket error: tear everything down so main() rebuilds it
        SocketClose clientSocket;
        SocketClose serverSocket;
        RETURN;
    ENDPROC

    PROC ServeClient()
        WHILE TRUE DO
            ! Block until a command line arrives from the client
            SocketReceive clientSocket \Str:=rxStr \Time:=WAIT_MAX;
            Dispatch rxStr;
            IF bEgmRequested THEN
                ! EGMJOINT received -- close this client connection and
                ! unwind back to ServeForever, which closes the server
                ! socket too before returning to main().
                SocketClose clientSocket;
                RETURN;
            ENDIF
        ENDWHILE
    ERROR
        IF ERRNO = ERR_SOCK_CLOSED THEN
            ! Client disconnected - close and go back to SocketAccept
            SocketClose clientSocket;
            RETURN;
        ENDIF
        ! Motion error from a \Conc move surfaces here at the next sync point
        ! (SocketReceive). Clear the path and go back to listening.
        StopMove;
        ClearPath;
        StartMove;
        RETRY;
    ENDPROC

    ! Parse one command, run the routine, send the ack
    PROC Dispatch(string raw)
        VAR string cmd;
        VAR string rawclean;
        rawclean := StripCtrl(raw);
        cmd := CleanCmd(raw);
        ! Ack first (snappy UI), then run the move. If the command is
        ! unknown, reply ERR and do not move.
        TEST cmd
        CASE "HOME":
            SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
            rGoHome;
        CASE "SETHOME":
            ! Redefine HOME as the current pose and persist it (survives restart/reload)
            pHome := CRobT(\Tool:=tGripper \WObj:=wobj1);
            SaveHome;
            SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
        CASE "P1":
            SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
            rPickPos1;
        CASE "P2":
            SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
            rPickPos2;
        CASE "P3":
            SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
            rPlacePos;
        CASE "PING":
            SocketSend clientSocket \Str:=("OK:PING" + ByteToStr(10\Char));
        CASE "STOP":
            StopMove;
            ClearPath;
            StartMove;
            bStopMotion := FALSE;
            SocketSend clientSocket \Str:=("OK:STOP" + ByteToStr(10\Char));
        CASE "GRIPON":
            SocketSend clientSocket \Str:=("OK:GRIPON" + ByteToStr(10\Char));
        CASE "GRIPOFF":
            SocketSend clientSocket \Str:=("OK:GRIPOFF" + ByteToStr(10\Char));
        CASE "RESETLED":
            ! Restore LED to normal RAPID-running state (static green)
            SetGO Asi1LedRed,    0;
            SetGO Asi1LedGreen,  255;
            SetGO Asi1LedBlue,   0;
            SetGO Asi1LedPeriod, 0;
            SocketSend clientSocket \Str:=("OK:RESETLED" + ByteToStr(10\Char));
        CASE "EGMJOINT":
            ! Ack, then hand control to main() via bEgmRequested -- see
            ! ServeClient/ServeForever/main for the unwind sequence.
            SocketSend clientSocket \Str:=("OK:EGMJOINT" + ByteToStr(10\Char));
            bEgmRequested := TRUE;
        DEFAULT:
            ! Not a named point - try GOTO <11 nums>, jog (X+20...),
            ! joint jog (J1+5), then speed override (SPEED50)
            IF TryGoTo(cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TryJog(cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TryJointJog(cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TrySpeed(cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TryMoveJ(cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TryZone(cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TryGetVar(cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TrySetVar(rawclean, cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TrySetLed(cmd) THEN
                ! handled (ack sent inside)
            ELSEIF TrySetDo(cmd) THEN
                ! handled (ack sent inside)
            ELSE
                SocketSend clientSocket \Str:=("ERR:" + cmd + ByteToStr(10\Char));
            ENDIF
        ENDTEST
    ENDPROC

    ! -------------------------------------------------------
    ! EGM (Externally Guided Motion) joint-streaming session
    ! -------------------------------------------------------
    ! One EGM joint session over UDPUC transmission protocol "EGM_PC"
    ! (RobotStudio > Controller > Configuration > Communication >
    ! Transmission Protocol -- one-time setup, needs a controller restart;
    ! see CLAUDE.md). Blocks this task for the duration, which is why the
    ! TCP server sockets are already closed by the time this runs (see
    ! ServeClient/ServeForever) -- main() rebuilds them when this returns.
    !
    ! CORRECTED after a live test (2026-07-09): session exit is NOT
    ! comm-driven. The original design here assumed \CommTimeout would
    ! raise a comm-timeout error once gofa-egm stopped replying, letting
    ! the ERROR handler below reset and fall back to TCP serving on its
    ! own -- confirmed FALSE live: with a real EGM session already
    ! connected and streaming, going silent left this task blocked inside
    ! EGMRunJoint for 2+ minutes with no error and no recovery. Whatever
    ! \CommTimeout actually governs, it is not "seconds of silence before
    ! giving up" in a way this can rely on.
    !
    ! The mechanism that DOES reliably work, confirmed live twice: an
    ! external RWS stop (POST /rw/rapid/execution/stop) hard-interrupts
    ! EGMRunJoint immediately, regardless of EGM state. gofa-egm's stop
    ! action now drives that explicitly (stop -> resetpp -> start) instead
    ! of just going quiet and hoping. A stop does NOT run this ERROR
    ! handler or any of RunEgmJoint's own cleanup -- it's an external
    ! interrupt, not a RAPID error -- which is exactly why bEgmRequested
    ! is cleared in main() BEFORE calling RunEgmJoint, not after: that's
    ! the only reset guaranteed to have already happened by the time the
    ! next resetpp+start runs.
    !
    ! \CommTimeout and \CondTime below are consequently no longer load-
    ! bearing for session exit -- CondTime is kept only as a documentation
    ! placeholder, NOT a working backstop (see next paragraph).
    !
    ! TESTED AND DISPROVEN (2026-07-09): hypothesized that a SHORT CondTime
    ! (as opposed to the original 300s) might let EGMRunJoint return
    ! normally on its own once the client goes quiet, avoiding the need for
    ! an external kill and the EGM-instance leak that causes (see below).
    ! Live test: CondTime set to 6, a real session started and confirmed
    ! streaming, then the Node-RED-side process was killed abruptly with no
    ! stop() call (simulating a crash, not a clean disconnect). Result:
    ! still blocked inside EGMRunJoint 70+ seconds later (11x+ CondTime) --
    ! ctrlexecstate stayed "running", no error, no recovery. CondTime does
    ! NOT cause a graceful self-exit on this firmware, full stop. Do not
    ! re-attempt this fix without genuinely new evidence -- the external
    ! RWS-stop design is confirmed necessary, not just a first guess.
    !
    ! Known cost of that design: each external stop skips this proc's own
    ! cleanup (the EGMReset calls below and in ERROR), which appears to
    ! leak the underlying controller-side EGM instance -- confirmed live
    ! that repeated start/stop cycles (~8 in 90s) eventually produce RAPID
    ! error "Too many EGM instances," recoverable only by a full controller
    ! restart (elog/RWS show zero visibility into EGM/UC state to clear it
    ! any other way). No fix found by RAPID-level means alone -- see below,
    ! this is what the interrupt/EGMStop mechanism actually fixes.
    !
    ! FIXED (2026-07-09), per ABB's own EGM Application Manual
    ! (3HAC073318): EGMStop is a real instruction, documented specifically
    ! to be called "in a TRAP routine" or "from a RAPID TRAP or background
    ! task" to stop an in-progress EGMRunJoint/EGMRunPose. Unlike an
    ! external RWS task-level stop, a TRAP-driven EGMStop makes EGMRunJoint
    ! return NORMALLY -- so the cleanup below (IDelete + EGMReset) runs
    ! every time, and the underlying EGM instance is actually released.
    ! The manual also confirms the "Too many EGM instances" ceiling: max 4
    ! concurrent EGM identities, matching exactly what was seen live (~8
    ! leaked cycles was enough to exhaust it).
    !
    ! gofa-egm.js's stop() now sets ABB_Scalable_IO_0_DO16 via RWS
    ! (POST .../set-value, lvalue=1) instead of issuing an RWS task stop.
    ! CONNECT+ISignalDO below fires TrapEgmStop the moment that happens,
    ! EGMStop ends the session gracefully, and this task never actually
    ! stops -- main()'s loop just continues straight into ServeForever
    ! once RunEgmJoint returns. No resetpp/start needed on the Node-RED
    ! side anymore either.
    PROC RunEgmJoint()
        CONNECT egmStopIntNo WITH TrapEgmStop;
        ISignalDO ABB_Scalable_IO_0_DO16, 1, egmStopIntNo;

        EGMReset egmID1;
        EGMGetId egmID1;
        egmSt1 := EGMGetState(egmID1);

        IF egmSt1 <= EGM_STATE_CONNECTED THEN
            EGMSetupUC ROB_1, egmID1, "default", "EGM_PC" \Joint \CommTimeout:=5;
        ENDIF

        EGMActJoint egmID1
            \J1:=egm_minmax1 \J2:=egm_minmax1 \J3:=egm_minmax1
            \J4:=egm_minmax1 \J5:=egm_minmax1 \J6:=egm_minmax1
            \LpFilter:=3 \SampleRate:=24 \MaxSpeedDeviation:=30;

        EGMRunJoint egmID1, EGM_STOP_HOLD \J1 \J2 \J3 \J4 \J5 \J6
            \CondTime:=300 \RampInTime:=1.0;

        IDelete egmStopIntNo;
        SetDO ABB_Scalable_IO_0_DO16, 0;

        egmSt1 := EGMGetState(egmID1);
        IF egmSt1 = EGM_STATE_CONNECTED THEN
            EGMReset egmID1;
        ENDIF
    ERROR
        ! Comm timeout, TrapEgmStop's EGMStop surfacing here instead of a
        ! normal return, or any other EGM fault -- clean up and fall back
        ! to TCP serving instead of leaving this task stuck.
        IDelete egmStopIntNo;
        SetDO ABB_Scalable_IO_0_DO16, 0;
        EGMReset egmID1;
        RETURN;
    ENDPROC

    ! Fired by ISignalDO in RunEgmJoint the moment gofa-egm.js sets
    ! ABB_Scalable_IO_0_DO16 via RWS. EGMStop makes the blocking
    ! EGMRunJoint above return normally (see the FIXED note above for why
    ! that matters -- it's what actually releases the EGM instance).
    TRAP TrapEgmStop
        EGMStop egmID1, EGM_STOP_HOLD;
    ENDTRAP

    ! Parse a jog token and execute it. Tokens (after CleanCmd):
    !   translation mm:  X+20  X-20  Y+20 ...   (base/work frame, via Offs)
    !   rotation deg:    RX+5  RY-5  RZ+5 ...   (tool frame, via RelTool)
    ! Returns FALSE (-> caller sends ERR) if it isn't a valid, in-range jog.
    FUNC bool TryJog(string cmd)
        VAR num n;
        VAR num idx := 1;
        VAR bool rot := FALSE;
        VAR string axis;
        VAR string sgn;
        VAR string magStr;
        VAR num mag;
        VAR num val;

        n := StrLen(cmd);
        IF n < 3 RETURN FALSE;
        IF StrPart(cmd, 1, 1) = "R" THEN
            rot := TRUE;
            idx := 2;
            IF n < 4 RETURN FALSE;
        ENDIF
        axis := StrPart(cmd, idx, 1);
        sgn  := StrPart(cmd, idx + 1, 1);
        magStr := StrPart(cmd, idx + 2, n - (idx + 1));
        IF NOT StrToVal(magStr, mag) RETURN FALSE;
        IF mag <= 0 RETURN FALSE;
        IF axis <> "X" AND axis <> "Y" AND axis <> "Z" RETURN FALSE;
        IF rot THEN
            IF mag > JOG_MAX_DEG RETURN FALSE;
        ELSE
            IF mag > JOG_MAX_MM RETURN FALSE;
        ENDIF
        IF sgn = "+" THEN
            val := mag;
        ELSEIF sgn = "-" THEN
            val := -mag;
        ELSE
            RETURN FALSE;
        ENDIF

        ! Valid -> ack first (snappy UI), then move
        SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
        JogMove axis, val, rot;
        RETURN TRUE;
    ENDFUNC

    ! Relative Cartesian move from the current pose. Translation is base/work
    ! frame (Offs); rotation is tool frame (RelTool). The ERROR handler keeps
    ! the socket server alive if the target is unreachable / hits a limit.
    PROC JogMove(string axis, num val, bool rot)
        VAR robtarget p;
        p := CRobT(\Tool:=tGripper \WObj:=wobj1);
        StopMove;
        ClearPath;
        StartMove;
        IF rot THEN
            TEST axis
            CASE "X": MoveJ \Conc, RelTool(p, 0, 0, 0 \Rx:=val), vJog, fine, tGripper \WObj:=wobj1;
            CASE "Y": MoveJ \Conc, RelTool(p, 0, 0, 0 \Ry:=val), vJog, fine, tGripper \WObj:=wobj1;
            CASE "Z": MoveJ \Conc, RelTool(p, 0, 0, 0 \Rz:=val), vJog, fine, tGripper \WObj:=wobj1;
            ENDTEST
        ELSE
            TEST axis
            CASE "X": MoveJ \Conc, Offs(p, val, 0, 0), vJog, fine, tGripper \WObj:=wobj1;
            CASE "Y": MoveJ \Conc, Offs(p, 0, val, 0), vJog, fine, tGripper \WObj:=wobj1;
            CASE "Z": MoveJ \Conc, Offs(p, 0, 0, val), vJog, fine, tGripper \WObj:=wobj1;
            ENDTEST
        ENDIF
    ENDPROC

    ! Parse a joint-jog token and execute it. Token (after CleanCmd):
    !   Jn+d  Jn-d   n = axis 1..6, d = degrees (relative, current pose)
    ! Returns FALSE (-> caller tries next handler) if it isn't a valid joint jog.
    FUNC bool TryJointJog(string cmd)
        VAR num n;
        VAR num jointNo;
        VAR string sgn;
        VAR num mag;
        VAR num val;
        VAR jointtarget jt;

        n := StrLen(cmd);
        IF n < 4 RETURN FALSE;
        IF StrPart(cmd, 1, 1) <> "J" RETURN FALSE;
        IF NOT StrToVal(StrPart(cmd, 2, 1), jointNo) RETURN FALSE;
        IF jointNo < 1 OR jointNo > 6 RETURN FALSE;
        sgn := StrPart(cmd, 3, 1);
        IF NOT StrToVal(StrPart(cmd, 4, n - 3), mag) RETURN FALSE;
        IF mag <= 0 OR mag > JOINT_MAX_DEG RETURN FALSE;
        IF sgn = "+" THEN
            val := mag;
        ELSEIF sgn = "-" THEN
            val := -mag;
        ELSE
            RETURN FALSE;
        ENDIF

        ! Valid -> ack first (snappy UI), then move the chosen axis
        SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
        jt := CJointT();
        TEST jointNo
        CASE 1: jt.robax.rax_1 := jt.robax.rax_1 + val;
        CASE 2: jt.robax.rax_2 := jt.robax.rax_2 + val;
        CASE 3: jt.robax.rax_3 := jt.robax.rax_3 + val;
        CASE 4: jt.robax.rax_4 := jt.robax.rax_4 + val;
        CASE 5: jt.robax.rax_5 := jt.robax.rax_5 + val;
        CASE 6: jt.robax.rax_6 := jt.robax.rax_6 + val;
        ENDTEST
        StopMove;
        ClearPath;
        StartMove;
        MoveAbsJ \Conc, jt, vJog, fine, tGripper \WObj:=wobj1;
        RETURN TRUE;
    ENDFUNC

    ! Set the speed override (scales every move). Token: SPEEDnn (1..100).
    ! Uses SpeedRefresh so it takes effect immediately, no mastership needed.
    ! Returns FALSE (-> caller sends ERR) if it isn't a valid speed token.
    FUNC bool TrySpeed(string cmd)
        VAR num n;
        VAR num spd;
        n := StrLen(cmd);
        IF n < 6 RETURN FALSE;
        IF StrPart(cmd, 1, 5) <> "SPEED" RETURN FALSE;
        IF NOT StrToVal(StrPart(cmd, 6, n - 5), spd) RETURN FALSE;
        IF spd < 1 OR spd > 100 RETURN FALSE;
        SpeedRefresh spd;
        SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
        RETURN TRUE;
    ENDFUNC

    ! Go to a saved point. Token: GOTO<x;y;z;q1;q2;q3;q4;cf1;cf4;cf6;cfx>
    ! (11 numbers, the full robtarget). Node-RED only ever sends stored,
    ! real poses, so the target is inherently reachable. Returns FALSE
    ! (no ack) if it isn't a GOTO token.
    ! Token: GOTOJ<11 nums> or GOTOL<11 nums> selects MoveJ (joint-interpolated,
    ! default) or MoveL (straight-line TCP path) to the target. Bare GOTO<11 nums>
    ! (no J/L letter) is accepted as an alias for GOTOJ for backward compatibility.
    ! MoveL follows a straight line and can hit singularities/joint limits that
    ! MoveJ would route around to reach the same target - caller's choice.
    FUNC bool TryGoTo(string cmd)
        VAR num n;
        VAR num qn;
        VAR num vals{11};
        VAR robtarget t;
        VAR bool linear;
        VAR num prefixLen;
        n := StrLen(cmd);
        IF n < 5 RETURN FALSE;
        IF StrPart(cmd, 1, 5) = "GOTOJ" THEN
            linear := FALSE;
            prefixLen := 5;
        ELSEIF StrPart(cmd, 1, 5) = "GOTOL" THEN
            linear := TRUE;
            prefixLen := 5;
        ELSEIF StrPart(cmd, 1, 4) = "GOTO" THEN
            linear := FALSE;
            prefixLen := 4;
        ELSE
            RETURN FALSE;
        ENDIF
        IF NOT ParseNums(StrPart(cmd, prefixLen + 1, n - prefixLen), vals) RETURN FALSE;
        ! Re-normalize the quaternion (Node-RED rounds it to keep the token
        ! under RAPID's 80-char string limit), else MoveJ/MoveL rejects it.
        qn := Sqrt(vals{4} * vals{4} + vals{5} * vals{5} + vals{6} * vals{6} + vals{7} * vals{7});
        IF qn = 0 RETURN FALSE;
        t.trans   := [vals{1}, vals{2}, vals{3}];
        t.rot     := [vals{4} / qn, vals{5} / qn, vals{6} / qn, vals{7} / qn];
        t.robconf := [vals{8}, vals{9}, vals{10}, vals{11}];
        t.extax   := [9E9, 9E9, 9E9, 9E9, 9E9, 9E9];
        ! Valid -> ack first (snappy UI), then move
        SocketSend clientSocket \Str:=("OK:GOTO" + ByteToStr(10\Char));
        IF linear THEN
            MoveL \Conc, t, vGoto, fine, tGripper \WObj:=wobj1;
        ELSE
            MoveJ \Conc, t, vGoto, fine, tGripper \WObj:=wobj1;
        ENDIF
        RETURN TRUE;
    ENDFUNC

    ! Split a ';'-separated number string into arr; must fill it exactly.
    FUNC bool ParseNums(string s, INOUT num arr{*})
        VAR num count := 0;
        VAR num start := 1;
        VAR num i;
        VAR num L;
        VAR string seg;
        VAR num v;
        L := StrLen(s);
        FOR i FROM 1 TO L + 1 DO
            IF i > L OR StrPart(s, i, 1) = ";" THEN
                seg := StrPart(s, start, i - start);
                count := count + 1;
                IF count > Dim(arr, 1) RETURN FALSE;
                IF NOT StrToVal(seg, v) RETURN FALSE;
                arr{count} := v;
                start := i + 1;
            ENDIF
        ENDFOR
        RETURN count = Dim(arr, 1);
    ENDFUNC

    ! Persist pHome to HOME_FILE as one line of 11 ;-separated numbers (same
    ! layout as a GOTO token). Pos 1 dp, quat 5 dp, conf int -> ~63 chars, well
    ! under RAPID's 80-char string cap. Silently no-ops on any file error.
    PROC SaveHome()
        VAR iodev f;
        VAR bool opened := FALSE;
        Open HOME_FILE, f \Write;
        opened := TRUE;
        Write f, NumToStr(pHome.trans.x,1) + ";" + NumToStr(pHome.trans.y,1) + ";" + NumToStr(pHome.trans.z,1) + ";" + NumToStr(pHome.rot.q1,5) + ";" + NumToStr(pHome.rot.q2,5) + ";" + NumToStr(pHome.rot.q3,5) + ";" + NumToStr(pHome.rot.q4,5) + ";" + NumToStr(pHome.robconf.cf1,0) + ";" + NumToStr(pHome.robconf.cf4,0) + ";" + NumToStr(pHome.robconf.cf6,0) + ";" + NumToStr(pHome.robconf.cfx,0);
        Close f;
    ERROR
        IF opened Close f;
        RETURN;
    ENDPROC

    ! Load pHome from HOME_FILE at startup. Missing/unreadable file -> keep the
    ! module's literal default (the ERROR handler just returns).
    PROC LoadHome()
        VAR iodev f;
        VAR bool opened := FALSE;
        VAR string line;
        VAR num v{11};
        VAR num qn;
        Open HOME_FILE, f \Read;
        opened := TRUE;
        line := ReadStr(f);
        Close f;
        opened := FALSE;
        IF NOT ParseNums(line, v) RETURN;
        ! Re-normalize the quaternion (stored at 5 dp, so not exactly unit).
        qn := Sqrt(v{4} * v{4} + v{5} * v{5} + v{6} * v{6} + v{7} * v{7});
        IF qn = 0 RETURN;
        pHome := [[v{1}, v{2}, v{3}],
                  [v{4} / qn, v{5} / qn, v{6} / qn, v{7} / qn],
                  [v{8}, v{9}, v{10}, v{11}],
                  [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
    ERROR
        IF opened Close f;
        RETURN;
    ENDPROC

    ! Strip control chars / whitespace and uppercase, so "p1\r\n" -> "P1"
    FUNC string CleanCmd(string raw)
        VAR string out := "";
        VAR string ch;
        VAR num i;
        FOR i FROM 1 TO StrLen(raw) DO
            ch := StrPart(raw, i, 1);
            IF StrToByte(ch\Char) > 32 THEN
                out := out + ch;
            ENDIF
        ENDFOR
        RETURN StrMap(out, "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    ENDFUNC

    ! -------------------------------------------------------
    ! MOTION ROUTINES (unchanged)
    ! -------------------------------------------------------

    PROC rGoHome()
        MoveJ \Conc, pHome, v200, z50, tGripper \WObj:=wobj1;
    ENDPROC

    PROC rPickPos1()
        MoveJ \Conc, pPickPos1, v200, z10, tGripper \WObj:=wobj1;
    ENDPROC

    PROC rPickPos2()
        MoveJ \Conc, pPickPos2, v200, z10, tGripper \WObj:=wobj1;
    ENDPROC

    PROC rPlacePos()
        MoveJ \Conc, pPlacePos, v200, z10, tGripper \WObj:=wobj1;
    ENDPROC

    PROC rPickAndPlace()
        ! Full sequence: pick from pos1, go to place, return home
        rPickPos1;
        rPlacePos;
        rGoHome;
    ENDPROC

    ! Absolute joint move. Token: MOVEJ<j1;j2;j3;j4;j5;j6> (degrees).
    ! Checks and clears bStopMotion before executing. Returns FALSE if
    ! not a MOVEJ token or parse fails.
    FUNC bool TryMoveJ(string cmd)
        VAR num n;
        VAR num vals{6};
        VAR jointtarget jt;
        n := StrLen(cmd);
        IF n < 6 RETURN FALSE;
        IF StrPart(cmd, 1, 5) <> "MOVEJ" RETURN FALSE;
        IF NOT ParseNums(StrPart(cmd, 6, n - 5), vals) RETURN FALSE;
        jt.robax := [vals{1}, vals{2}, vals{3}, vals{4}, vals{5}, vals{6}];
        jt.extax := [9E9, 9E9, 9E9, 9E9, 9E9, 9E9];
        SocketSend clientSocket \Str:=("OK:MOVEJ" + ByteToStr(10\Char));
        MoveAbsJ \Conc, jt, vGoto, zActive, tGripper \WObj:=wobj1;
        RETURN TRUE;
    ENDFUNC

    ! Set the active zone data. Token: ZONE<name> (FINE, Z1, Z5, Z10, Z20, Z50, Z100).
    ! Returns FALSE if not a ZONE token or unrecognised zone name.
    FUNC bool TryZone(string cmd)
        VAR num n;
        VAR string zname;
        n := StrLen(cmd);
        IF n < 5 RETURN FALSE;
        IF StrPart(cmd, 1, 4) <> "ZONE" RETURN FALSE;
        zname := StrPart(cmd, 5, n - 4);
        TEST zname
        CASE "FINE":  zActive := fine;
        CASE "Z1":    zActive := z1;
        CASE "Z5":    zActive := z5;
        CASE "Z10":   zActive := z10;
        CASE "Z20":   zActive := z20;
        CASE "Z50":   zActive := z50;
        CASE "Z100":  zActive := z100;
        DEFAULT: RETURN FALSE;
        ENDTEST
        SocketSend clientSocket \Str:=("OK:ZONE" + zname + ByteToStr(10\Char));
        RETURN TRUE;
    ENDFUNC

    ! Strip only CR and LF so string variable values keep their spaces.
    FUNC string StripCtrl(string raw)
        VAR string out := "";
        VAR string ch;
        VAR num i;
        VAR num b;
        FOR i FROM 1 TO StrLen(raw) DO
            ch := StrPart(raw, i, 1);
            b  := StrToByte(ch\Char);
            IF b <> 10 AND b <> 13 THEN
                out := out + ch;
            ENDIF
        ENDFOR
        RETURN out;
    ENDFUNC

    ! Read a PERS variable by name. Token (after CleanCmd): GETVAR:<VARNAME>
    ! Sends VAL:<value> on success, ERR:UNKNOWN_VAR if not in the list.
    FUNC bool TryGetVar(string cmd)
        VAR string varname;
        IF StrLen(cmd) < 8 RETURN FALSE;
        IF StrPart(cmd, 1, 7) <> "GETVAR:" RETURN FALSE;
        varname := StrPart(cmd, 8, StrLen(cmd) - 7);
        IF varname = "NTESTVAR" THEN
            SocketSend clientSocket \Str:=("VAL:" + NumToStr(nTestVar, 6) + ByteToStr(10\Char));
        ELSEIF varname = "STESTMSG" THEN
            SocketSend clientSocket \Str:=("VAL:" + sTestMsg + ByteToStr(10\Char));
        ELSE
            SocketSend clientSocket \Str:=("ERR:UNKNOWN_VAR" + ByteToStr(10\Char));
        ENDIF
        RETURN TRUE;
    ENDFUNC

    ! Write a PERS variable by name. rawclean preserves original case for string values.
    ! Token (cmd is uppercased): SETVAR:<VARNAME>:<value>
    FUNC bool TrySetVar(string rawclean, string cmd)
        VAR string varname;
        VAR string valstr;
        VAR num colonPos := 0;
        VAR num i;
        IF StrLen(cmd) < 9 RETURN FALSE;
        IF StrPart(cmd, 1, 7) <> "SETVAR:" RETURN FALSE;
        ! Find the colon between varname and value (first colon after position 8)
        FOR i FROM 8 TO StrLen(cmd) DO
            IF StrPart(cmd, i, 1) = ":" AND colonPos = 0 THEN
                colonPos := i;
            ENDIF
        ENDFOR
        IF colonPos = 0 RETURN FALSE;
        varname := StrPart(cmd, 8, colonPos - 8);
        ! Use rawclean (original case, spaces preserved) for the value
        valstr := StrPart(rawclean, colonPos + 1, StrLen(rawclean) - colonPos);
        IF varname = "NTESTVAR" THEN
            IF NOT StrToVal(valstr, nTestVar) THEN
                SocketSend clientSocket \Str:=("ERR:PARSE" + ByteToStr(10\Char));
                RETURN TRUE;
            ENDIF
            SocketSend clientSocket \Str:=("OK:SETVAR" + ByteToStr(10\Char));
        ELSEIF varname = "STESTMSG" THEN
            sTestMsg := valstr;
            SocketSend clientSocket \Str:=("OK:SETVAR" + ByteToStr(10\Char));
        ELSE
            SocketSend clientSocket \Str:=("ERR:UNKNOWN_VAR" + ByteToStr(10\Char));
        ENDIF
        RETURN TRUE;
    ENDFUNC

    ! Set ASI RGB LED. Token: SETLED:<r>;<g>;<b>;<period>  (0-255 each).
    ! Uses SetGO — requires RAPID write access on the ASI signals.
    FUNC bool TrySetLed(string cmd)
        VAR num vals{4};
        IF StrLen(cmd) < 9 RETURN FALSE;
        IF StrPart(cmd, 1, 7) <> "SETLED:" RETURN FALSE;
        IF NOT ParseNums(StrPart(cmd, 8, StrLen(cmd) - 7), vals) RETURN FALSE;
        SetGO Asi1LedRed,    vals{1};
        SetGO Asi1LedGreen,  vals{2};
        SetGO Asi1LedBlue,   vals{3};
        SetGO Asi1LedPeriod, vals{4};
        SocketSend clientSocket \Str:=("OK:SETLED" + ByteToStr(10\Char));
        RETURN TRUE;
    ENDFUNC

    ! Set a DSQC1030 (Scalable I/O) digital output by name. Token: SETDO:<name>:<value>
    ! e.g. SETDO:ABB_SCALABLE_IO_0_DO1:1  (value must be 0 or 1).
    ! Goes through RAPID's SetDO instead of RWS — this signal's write-access
    ! (Rapid|LocalManual, even with Access Level "All") only covers writes from
    ! RAPID/local sources; RWS POST to /rw/iosystem/signals/{name}/set 405s
    ! regardless (confirmed: this controller's iosystem resource only allows
    ! GET/OPTIONS, same as every other signal tested, not just this device).
    ! Allow-listed per signal (same pattern as TryGetVar/TrySetVar) since RAPID
    ! has no way to resolve an arbitrary runtime string into a signal reference.
    FUNC bool TrySetDo(string cmd)
        VAR string signame;
        VAR string valstr;
        VAR num val;
        VAR num colonPos := 0;
        VAR num i;
        IF StrLen(cmd) < 8 RETURN FALSE;
        IF StrPart(cmd, 1, 6) <> "SETDO:" RETURN FALSE;
        FOR i FROM 7 TO StrLen(cmd) DO
            IF StrPart(cmd, i, 1) = ":" AND colonPos = 0 THEN
                colonPos := i;
            ENDIF
        ENDFOR
        IF colonPos = 0 RETURN FALSE;
        signame := StrPart(cmd, 7, colonPos - 7);
        valstr  := StrPart(cmd, colonPos + 1, StrLen(cmd) - colonPos);
        IF NOT StrToVal(valstr, val) THEN
            SocketSend clientSocket \Str:=("ERR:PARSE" + ByteToStr(10\Char));
            RETURN TRUE;
        ENDIF
        IF val <> 0 AND val <> 1 THEN
            SocketSend clientSocket \Str:=("ERR:PARSE" + ByteToStr(10\Char));
            RETURN TRUE;
        ENDIF
        TEST signame
        CASE "ABB_SCALABLE_IO_0_DO1":  SetDO ABB_Scalable_IO_0_DO1,  val;
        CASE "ABB_SCALABLE_IO_0_DO2":  SetDO ABB_Scalable_IO_0_DO2,  val;
        CASE "ABB_SCALABLE_IO_0_DO3":  SetDO ABB_Scalable_IO_0_DO3,  val;
        CASE "ABB_SCALABLE_IO_0_DO4":  SetDO ABB_Scalable_IO_0_DO4,  val;
        CASE "ABB_SCALABLE_IO_0_DO5":  SetDO ABB_Scalable_IO_0_DO5,  val;
        CASE "ABB_SCALABLE_IO_0_DO6":  SetDO ABB_Scalable_IO_0_DO6,  val;
        CASE "ABB_SCALABLE_IO_0_DO7":  SetDO ABB_Scalable_IO_0_DO7,  val;
        CASE "ABB_SCALABLE_IO_0_DO8":  SetDO ABB_Scalable_IO_0_DO8,  val;
        CASE "ABB_SCALABLE_IO_0_DO9":  SetDO ABB_Scalable_IO_0_DO9,  val;
        CASE "ABB_SCALABLE_IO_0_DO10": SetDO ABB_Scalable_IO_0_DO10, val;
        CASE "ABB_SCALABLE_IO_0_DO11": SetDO ABB_Scalable_IO_0_DO11, val;
        CASE "ABB_SCALABLE_IO_0_DO12": SetDO ABB_Scalable_IO_0_DO12, val;
        CASE "ABB_SCALABLE_IO_0_DO13": SetDO ABB_Scalable_IO_0_DO13, val;
        CASE "ABB_SCALABLE_IO_0_DO14": SetDO ABB_Scalable_IO_0_DO14, val;
        CASE "ABB_SCALABLE_IO_0_DO15": SetDO ABB_Scalable_IO_0_DO15, val;
        CASE "ABB_SCALABLE_IO_0_DO16": SetDO ABB_Scalable_IO_0_DO16, val;
        DEFAULT:
            SocketSend clientSocket \Str:=("ERR:UNKNOWN_SIGNAL" + ByteToStr(10\Char));
            RETURN TRUE;
        ENDTEST
        SocketSend clientSocket \Str:=("OK:SETDO" + ByteToStr(10\Char));
        RETURN TRUE;
    ENDFUNC

ENDMODULE
