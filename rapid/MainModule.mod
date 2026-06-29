MODULE MainModule

    ! -------------------------------------------------------
    ! ABB GoFa CRB 15000 - Socket command server
    ! main() runs a TCP server on :1025 forever. Node-RED
    ! connects and sends a one-line command; this program
    ! dispatches to the matching routine and replies "OK:<cmd>".
    !
    ! Protocol (newline-terminated, case-insensitive):
    !   HOME -> rGoHome      P1 -> rPickPos1
    !   P2   -> rPickPos2    P3 -> rPlacePos
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
    CONST string SERVER_IP   := "192.168.20.17";
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
    ! MAIN - go home, then serve forever. Any socket fault
    ! tears the server down and rebuilds it (robust to a
    ! Node-RED restart or a dropped connection).
    ! -------------------------------------------------------
    PROC main()
        LoadHome;
        WHILE TRUE DO
            ServeForever;
            WaitTime 1;
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
        ENDWHILE
    ERROR
        IF ERRNO = ERR_SOCK_CLOSED THEN
            ! Client disconnected - close and go back to SocketAccept
            SocketClose clientSocket;
            RETURN;
        ENDIF
        RAISE;
    ENDPROC

    ! Parse one command, run the routine, send the ack
    PROC Dispatch(string raw)
        VAR string cmd;
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
            bStopMotion := TRUE;
            StopMove;
            ClearPath;
            StartMove;
            SocketSend clientSocket \Str:=("OK:STOP" + ByteToStr(10\Char));
        CASE "GRIPON":
            SocketSend clientSocket \Str:=("OK:GRIPON" + ByteToStr(10\Char));
        CASE "GRIPOFF":
            SocketSend clientSocket \Str:=("OK:GRIPOFF" + ByteToStr(10\Char));
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
            ELSE
                SocketSend clientSocket \Str:=("ERR:" + cmd + ByteToStr(10\Char));
            ENDIF
        ENDTEST
    ENDPROC

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
        IF rot THEN
            TEST axis
            CASE "X": MoveJ RelTool(p, 0, 0, 0 \Rx:=val), vJog, fine, tGripper \WObj:=wobj1;
            CASE "Y": MoveJ RelTool(p, 0, 0, 0 \Ry:=val), vJog, fine, tGripper \WObj:=wobj1;
            CASE "Z": MoveJ RelTool(p, 0, 0, 0 \Rz:=val), vJog, fine, tGripper \WObj:=wobj1;
            ENDTEST
        ELSE
            TEST axis
            CASE "X": MoveJ Offs(p, val, 0, 0), vJog, fine, tGripper \WObj:=wobj1;
            CASE "Y": MoveJ Offs(p, 0, val, 0), vJog, fine, tGripper \WObj:=wobj1;
            CASE "Z": MoveJ Offs(p, 0, 0, val), vJog, fine, tGripper \WObj:=wobj1;
            ENDTEST
        ENDIF
    ERROR
        ! ponytail: standard recover-and-continue; tune here if a limit hit ever wedges motion
        StopMove;
        ClearPath;
        StartMove;
        RETURN;
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
        MoveAbsJ jt, vJog, fine, tGripper \WObj:=wobj1;
        RETURN TRUE;
    ERROR
        ! out of range / limit: recover, keep server alive (already acked)
        StopMove;
        ClearPath;
        StartMove;
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
    FUNC bool TryGoTo(string cmd)
        VAR num n;
        VAR num qn;
        VAR num vals{11};
        VAR robtarget t;
        n := StrLen(cmd);
        IF n < 5 RETURN FALSE;
        IF StrPart(cmd, 1, 4) <> "GOTO" RETURN FALSE;
        IF NOT ParseNums(StrPart(cmd, 5, n - 4), vals) RETURN FALSE;
        ! Re-normalize the quaternion (Node-RED rounds it to keep the token
        ! under RAPID's 80-char string limit), else MoveJ rejects it.
        qn := Sqrt(vals{4} * vals{4} + vals{5} * vals{5} + vals{6} * vals{6} + vals{7} * vals{7});
        IF qn = 0 RETURN FALSE;
        t.trans   := [vals{1}, vals{2}, vals{3}];
        t.rot     := [vals{4} / qn, vals{5} / qn, vals{6} / qn, vals{7} / qn];
        t.robconf := [vals{8}, vals{9}, vals{10}, vals{11}];
        t.extax   := [9E9, 9E9, 9E9, 9E9, 9E9, 9E9];
        ! Valid -> ack first (snappy UI), then move
        SocketSend clientSocket \Str:=("OK:GOTO" + ByteToStr(10\Char));
        MoveJ t, vGoto, fine, tGripper \WObj:=wobj1;
        RETURN TRUE;
    ERROR
        ! unreachable target: recover, keep server alive (already acked)
        StopMove;
        ClearPath;
        StartMove;
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
        MoveJ pHome, v200, z50, tGripper \WObj:=wobj1;
    ENDPROC

    PROC rPickPos1()
        MoveJ pPickPos1, v200, z10, tGripper \WObj:=wobj1;
        WaitTime 0.5;
    ENDPROC

    PROC rPickPos2()
        MoveJ pPickPos2, v200, z10, tGripper \WObj:=wobj1;
        WaitTime 0.5;
    ENDPROC

    PROC rPlacePos()
        MoveJ pPlacePos, v200, z10, tGripper \WObj:=wobj1;
        WaitTime 0.5;
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
        IF bStopMotion THEN
            bStopMotion := FALSE;
            SocketSend clientSocket \Str:=("OK:MOVEJ" + ByteToStr(10\Char));
            RETURN TRUE;
        ENDIF
        SocketSend clientSocket \Str:=("OK:MOVEJ" + ByteToStr(10\Char));
        MoveAbsJ jt, vGoto, zActive, tGripper \WObj:=wobj1;
        RETURN TRUE;
    ERROR
        StopMove;
        ClearPath;
        StartMove;
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

ENDMODULE
