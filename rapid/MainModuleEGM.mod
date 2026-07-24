MODULE MainModuleEGM

    ! -------------------------------------------------------
    ! ABB GoFa CRB 15000 - socket command server for the
    ! node-red-contrib-abb-gofa palette.
    !
    ! main() serves a TCP socket on SERVER_IP:1025 forever.
    ! One newline-terminated request in, one newline-terminated
    ! reply out. Two request formats, picked by the first byte:
    !   '{'  -> JSON, the real protocol the palette speaks:
    !           {"cmd":"ping"} -> {"status":"ok","cmd":"ping"}
    !           (command set: see DispatchJson below)
    !   else -> legacy plain text, kept for manual telnet/curl
    !           testing: PING -> OK:PING
    !           (see Dispatch below and MANUAL_CONTROL.md)
    ! The text protocol is fully case-insensitive (CleanCmd
    ! uppercases the whole line); JSON handlers normalize case
    ! per-field only where noted (getvar/setvar yes, setdo no).
    !
    ! Safety: the jog clamps JOG_MAX_MM / JOG_MAX_DEG /
    ! JOINT_MAX_DEG below are the safety knobs - keep them.
    !
    ! This EGM variant adds the EGMJOINT command: it acks,
    ! stops serving TCP, and runs an EGM joint-streaming
    ! session (RunEgmJoint) until the gofa-egm node signals
    ! stop via ABB_Scalable_IO_0_DO16 - see the EGM section
    ! in CLAUDE.md. Everything else is identical to
    ! MainModule.mod - keep the two files in lockstep.
    !
    ! SERVER_IP must be a real configured interface address
    ! (RAPID cannot bind a wildcard). The palette's upload
    ! paths rewrite it to the robot's IP automatically.
    ! -------------------------------------------------------

    ! ponytail: tGripper is UNUSED as of 2026-07-21 - no tool is physically
    ! mounted, so every motion instruction below now targets tool0 (RAPID's
    ! built-in empty-flange tool) instead of this placeholder [0,0,100] TCP
    ! offset / 1kg mass, which matched nothing real. That placeholder also
    ! disagreed with gofa-pose/gofa-save-point's RWS reads (already tool0/
    ! wobj0-relative), so leaving it active would have meant a saved point
    ! replays ~100mm off from where it was captured, not just a load-data
    ! safety gap. Upgrade path: once a real gripper is mounted, run
    ! LoadIdentify (or otherwise measure the real mass/CoG/inertia/TCP
    ! offset), populate the values below, then switch the tool argument on
    ! every motion instruction back from tool0 to tGripper.
    PERS tooldata tGripper := [TRUE, [[0,0,0],[1,0,0,0]], [1,[0,0,100],[1,0,0,0],0,0,0]];
    PERS wobjdata wobj1    := [FALSE, TRUE, "", [[0,0,0],[1,0,0,0]], [[0,0,0],[1,0,0,0]]];
    PERS zonedata zActive  := [FALSE, 10, 15, 15, 1.5, 15, 1.5];
    PERS bool bEgmRequested := FALSE;
    VAR egmident  egmID1;
    VAR egmstate  egmSt1;
    CONST egm_minmax egm_minmax1 := [-10.0, 10.0];
    VAR intnum egmStopIntNo;

    ! Test variables for RAPID Var Read / Write nodes
    ! Task: T_ROB1  Module: MainModule
    PERS num    nTestVar := 0;
    PERS string sTestMsg := "hello";

    ! Home = position robot was at during setup
    PERS robtarget pHome     := [[323.21,-81.81,807.00],
                                  [0.2671,0.1290,0.9536,-0.0528],
                                  [-1,-1,0,0],
                                  [9E9,9E9,9E9,9E9,9E9,9E9]];

    ! -------------------------------------------------------
    ! Socket server state
    ! -------------------------------------------------------
    CONST string SERVER_IP   := "192.168.1.103";
    CONST num    SERVER_PORT  := 1025;

    ! Reported in the "ping" JSON reply so the palette can detect a stale
    ! module (uploaded via an older npm version than the one now running)
    ! instead of failing mysteriously later on a command that doesn't exist
    ! yet. Bump this whenever the socket protocol changes; keep in lockstep
    ! with node-red-contrib-abb-gofa/package.json's "version".
    CONST string MODULE_VERSION := "2.4.13";

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
            IF bEgmRequested THEN
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
        VAR string firstChar;
        WHILE TRUE DO
            ! Block until a command line arrives from the client
            SocketReceive clientSocket \Str:=rxStr \Time:=WAIT_MAX;
            IF StrLen(rxStr) > 0 THEN
                firstChar := StrPart(rxStr, 1, 1);
                IF firstChar = "{" THEN
                    DispatchJson rxStr;
                ELSE
                    Dispatch rxStr;
                ENDIF
            ENDIF
            IF bEgmRequested THEN
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
        ! Motion error surfaces here at the next sync point (SocketReceive).
        ! Clear the path and go back to listening.
        StopMove;
        ClearPath;
        StartMove;
        RETRY;
    ENDPROC

    ! Finds the string value associated with a key in a flat JSON string
    FUNC bool GetJsonStringVal(string json, string key, INOUT string val)
        VAR num keyPos;
        VAR num startVal;
        VAR num endVal;
        VAR string quotedKey;
        quotedKey := """" + key + """";
        keyPos := StrMatch(json, 1, quotedKey);
        IF keyPos > StrLen(json) RETURN FALSE;
        startVal := StrMatch(json, keyPos + StrLen(quotedKey), """");
        IF startVal > StrLen(json) RETURN FALSE;
        endVal := StrMatch(json, startVal + 1, """");
        IF endVal > StrLen(json) RETURN FALSE;
        val := StrPart(json, startVal + 1, endVal - startVal - 1);
        RETURN TRUE;
    ENDFUNC

    ! Finds the numeric value associated with a key in a flat JSON string
    FUNC bool GetJsonNumVal(string json, string key, INOUT num val)
        VAR num keyPos;
        VAR num colonPos;
        VAR num endVal;
        VAR string quotedKey;
        VAR string valstr;
        quotedKey := """" + key + """";
        keyPos := StrMatch(json, 1, quotedKey);
        IF keyPos > StrLen(json) RETURN FALSE;
        colonPos := StrMatch(json, keyPos + StrLen(quotedKey), ":");
        IF colonPos > StrLen(json) RETURN FALSE;
        endVal := StrMatch(json, colonPos + 1, ",");
        IF endVal > StrLen(json) THEN
            endVal := StrMatch(json, colonPos + 1, "}");
        ENDIF
        IF endVal > StrLen(json) RETURN FALSE;
        valstr := StrPart(json, colonPos + 1, endVal - colonPos - 1);
        valstr := CleanCmd(valstr);
        RETURN StrToVal(valstr, val);
    ENDFUNC

    ! Finds the boolean value associated with a key in a flat JSON string
    FUNC bool GetJsonBoolVal(string json, string key, INOUT bool val)
        VAR num keyPos;
        VAR num colonPos;
        VAR num endVal;
        VAR string quotedKey;
        VAR string valstr;
        quotedKey := """" + key + """";
        keyPos := StrMatch(json, 1, quotedKey);
        IF keyPos > StrLen(json) RETURN FALSE;
        colonPos := StrMatch(json, keyPos + StrLen(quotedKey), ":");
        IF colonPos > StrLen(json) RETURN FALSE;
        endVal := StrMatch(json, colonPos + 1, ",");
        IF endVal > StrLen(json) THEN
            endVal := StrMatch(json, colonPos + 1, "}");
        ENDIF
        IF endVal > StrLen(json) RETURN FALSE;
        valstr := StrPart(json, colonPos + 1, endVal - colonPos - 1);
        valstr := CleanCmd(valstr);
        IF valstr = "TRUE" THEN
            val := TRUE;
            RETURN TRUE;
        ELSEIF valstr = "FALSE" THEN
            val := FALSE;
            RETURN TRUE;
        ENDIF
        RETURN FALSE;
    ENDFUNC

    ! Parses a numeric array associated with a key in a flat JSON string (e.g. "val":[1,2,3])
    FUNC bool GetJsonNumArray(string json, string key, INOUT num arr{*})
        VAR num keyPos;
        VAR num startBracket;
        VAR num endBracket;
        VAR string quotedKey;
        VAR string arrayStr;
        quotedKey := """" + key + """";
        keyPos := StrMatch(json, 1, quotedKey);
        IF keyPos > StrLen(json) RETURN FALSE;
        startBracket := StrMatch(json, keyPos + StrLen(quotedKey), "[");
        IF startBracket > StrLen(json) RETURN FALSE;
        endBracket := StrMatch(json, startBracket + 1, "]");
        IF endBracket > StrLen(json) RETURN FALSE;
        arrayStr := StrPart(json, startBracket + 1, endBracket - startBracket - 1);
        arrayStr := NormalizeCommas(arrayStr);
        RETURN ParseNums(arrayStr, arr);
    ENDFUNC

    ! Helper to replace commas with semicolons in a string
    FUNC string NormalizeCommas(string s)
        VAR string out := "";
        VAR string ch;
        VAR num i;
        FOR i FROM 1 TO StrLen(s) DO
            ch := StrPart(s, i, 1);
            IF ch = "," THEN
                out := out + ";";
            ELSE
                out := out + ch;
            ENDIF
        ENDFOR
        RETURN out;
    ENDFUNC

    TRAP TrapEgmStop
        EGMStop egmID1, EGM_STOP_HOLD;
    ENDTRAP

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
            \LpFilter:=4;

        EGMRunJoint egmID1, EGM_STOP_HOLD \J1 \J2 \J3 \J4 \J5 \J6
            \CondTime:=60 \RampOutTime:=0.05;

        IDelete egmStopIntNo;

        egmSt1 := EGMGetState(egmID1);
        IF egmSt1 = EGM_STATE_CONNECTED THEN
            EGMReset egmID1;
        ENDIF
    ERROR
        IDelete egmStopIntNo;
        EGMReset egmID1;
        CONNECT egmStopIntNo WITH TrapEgmStop;
        ISignalDO ABB_Scalable_IO_0_DO16, 1, egmStopIntNo;
        RETRY;
    ENDPROC

    ! JSON Dispatcher
    PROC DispatchJson(string json)
        VAR string cmd := "";
        VAR num vals{11};
        VAR num jointVals{6};
        VAR num ledVals{4};
        VAR string rotStr := "";
        VAR num val := 0;
        VAR string name := "";
        VAR string axis := "";
        VAR string sgn := "";
        VAR bool rot := FALSE;
        VAR num jointNo := 0;
        VAR robtarget t;
        VAR jointtarget jt;
        VAR num qn;
        VAR bool linear;
        VAR string varname;
        VAR string valstr;
        VAR num speedVal;
        VAR string zoneName;

        IF NOT GetJsonStringVal(json, "cmd", cmd) THEN
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""unknown"",""msg"":""invalid json command""}" + ByteToStr(10\Char));
            RETURN;
        ENDIF

        TEST cmd
        CASE "ping":
            SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""ping"",""version"":""" + MODULE_VERSION + """}" + ByteToStr(10\Char));
        CASE "home":
            SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""home""}" + ByteToStr(10\Char));
            rGoHome;
        CASE "sethome":
            pHome := CRobT(\Tool:=tool0 \WObj:=wobj1);
            SaveHome;
            SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""sethome""}" + ByteToStr(10\Char));
        CASE "stop":
            StopMove;
            ClearPath;
            StartMove;
            SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""stop""}" + ByteToStr(10\Char));
        CASE "resetled":
            SetGO Asi1LedRed,    0;
            SetGO Asi1LedGreen,  255;
            SetGO Asi1LedBlue,   0;
            SetGO Asi1LedPeriod, 0;
            SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""resetled""}" + ByteToStr(10\Char));
        CASE "speed":
            ! VelSet (not SpeedRefresh) — confirmed live 2026-07-21 that SpeedRefresh only
            ! updates the override for a movement ALREADY IN PROGRESS (per ABB's own RAPID
            ! reference), so calling it here, before the next move even starts, measurably did
            ! nothing to real motion speed. VelSet changes the PROGRAMMED velocity, persisting
            ! to every subsequent motion instruction until changed again — what this command was
            ! always meant to do. Second arg (5000) is a generously high absolute TCP-speed cap
            ! (matches the "high ceiling" value already used in vGoto/vJog's own v_leax field) so
            ! it never becomes the binding constraint — only the override% actually matters.
            IF GetJsonNumVal(json, "val", speedVal) THEN
                IF speedVal >= 1 AND speedVal <= 100 THEN
                    VelSet speedVal, 5000;
                    SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""speed""}" + ByteToStr(10\Char));
                    RETURN;
                ENDIF
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""speed"",""msg"":""invalid speed""}" + ByteToStr(10\Char));
        CASE "getspeed":
            ! Reads C_MOTSET.vel.oride, the predefined system data holding the CURRENT velocity
            ! override — unlike SpeedRefresh's override (nowhere readable), VelSet's override is
            ! exposed this way, so this can confirm what "speed" (above) actually set.
            speedVal := C_MOTSET.vel.oride;
            SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""getspeed"",""val"":""" + NumToStr(speedVal, 2) + """}" + ByteToStr(10\Char));
        CASE "zone":
            IF GetJsonStringVal(json, "val", zoneName) THEN
                TEST zoneName
                CASE "FINE":  zActive := fine;
                CASE "Z1":    zActive := z1;
                CASE "Z5":    zActive := z5;
                CASE "Z10":   zActive := z10;
                CASE "Z20":   zActive := z20;
                CASE "Z50":   zActive := z50;
                CASE "Z100":  zActive := z100;
                DEFAULT:
                    SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""zone"",""msg"":""unknown zone""}" + ByteToStr(10\Char));
                    RETURN;
                ENDTEST
                SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""zone""}" + ByteToStr(10\Char));
                RETURN;
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""zone"",""msg"":""invalid zone params""}" + ByteToStr(10\Char));
        CASE "gotoj", "gotol":
            linear := (cmd = "gotol");
            IF GetJsonNumArray(json, "val", vals) THEN
                qn := Sqrt(vals{4} * vals{4} + vals{5} * vals{5} + vals{6} * vals{6} + vals{7} * vals{7});
                IF qn <> 0 THEN
                    t.trans   := [vals{1}, vals{2}, vals{3}];
                    t.rot     := [vals{4} / qn, vals{5} / qn, vals{6} / qn, vals{7} / qn];
                    t.robconf := [vals{8}, vals{9}, vals{10}, vals{11}];
                    t.extax   := [9E9, 9E9, 9E9, 9E9, 9E9, 9E9];
                    SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""goto""}" + ByteToStr(10\Char));
                    ! No \Conc: chained \Conc GoTo/Move instructions across
                    ! repeated socket commands hit RAPID's advance-run \Conc
                    ! limit (error 40631, kills the whole task) - confirmed
                    ! live, and WaitRob \InPos-based synchronization could not
                    ! reliably prevent it regardless of tuning. Ack is already
                    ! sent above, so the client sees no difference; this just
                    ! makes the task block until the move physically finishes
                    ! before serving the next command (so STOP can no longer
                    ! interrupt an in-progress move - only queued ones).
                    IF linear THEN
                        MoveL t, vGoto, fine, tool0 \WObj:=wobj1;
                    ELSE
                        MoveJ t, vGoto, fine, tool0 \WObj:=wobj1;
                    ENDIF
                    RETURN;
                ENDIF
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""" + cmd + """,""msg"":""invalid target""}" + ByteToStr(10\Char));
        CASE "movej", "movel":
            IF GetJsonNumArray(json, "val", jointVals) THEN
                jt.robax := [jointVals{1}, jointVals{2}, jointVals{3}, jointVals{4}, jointVals{5}, jointVals{6}];
                jt.extax := [9E9, 9E9, 9E9, 9E9, 9E9, 9E9];
                SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""" + cmd + """}" + ByteToStr(10\Char));
                IF cmd = "movel" THEN
                    ! Straight-line TCP path to the pose those joints describe -
                    ! CalcRobT does the forward kinematics. Same singularity
                    ! caveat as gotol: the line can fault where MoveAbsJ would not.
                    MoveL CalcRobT(jt, tool0 \WObj:=wobj1), vGoto, zActive, tool0 \WObj:=wobj1;
                ELSE
                    MoveAbsJ jt, vGoto, zActive, tool0 \WObj:=wobj1;
                ENDIF
                RETURN;
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""" + cmd + """,""msg"":""invalid joints""}" + ByteToStr(10\Char));
        CASE "egmjoint":
            bEgmRequested := TRUE;
            SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""egmjoint""}" + ByteToStr(10\Char));
            RETURN;
        CASE "jog":
            IF GetJsonStringVal(json, "axis", axis) AND GetJsonStringVal(json, "sgn", sgn) AND GetJsonNumVal(json, "val", val) THEN
                IF NOT GetJsonBoolVal(json, "rot", rot) THEN
                    rot := FALSE;
                ENDIF
                IF val > 0 AND (axis = "X" OR axis = "Y" OR axis = "Z") THEN
                    IF (rot AND val <= JOG_MAX_DEG) OR (NOT rot AND val <= JOG_MAX_MM) THEN
                        IF sgn = "+" OR sgn = "-" THEN
                            IF sgn = "-" val := -val;
                            SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""jog""}" + ByteToStr(10\Char));
                            JogMove axis, val, rot;
                            RETURN;
                        ENDIF
                    ENDIF
                ENDIF
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""jog"",""msg"":""invalid jog params""}" + ByteToStr(10\Char));
        CASE "jointjog":
            IF GetJsonNumVal(json, "joint", jointNo) AND GetJsonStringVal(json, "sgn", sgn) AND GetJsonNumVal(json, "val", val) THEN
                IF jointNo >= 1 AND jointNo <= 6 AND val > 0 AND val <= JOINT_MAX_DEG THEN
                    IF sgn = "+" OR sgn = "-" THEN
                        IF sgn = "-" val := -val;
                        SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""jointjog""}" + ByteToStr(10\Char));
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
                        MoveAbsJ \Conc, jt, vJog, fine, tool0 \WObj:=wobj1;
                        RETURN;
                    ENDIF
                ENDIF
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""jointjog"",""msg"":""invalid jointjog params""}" + ByteToStr(10\Char));
        CASE "setled":
            IF GetJsonNumArray(json, "val", ledVals) THEN
                SetGO Asi1LedRed,    ledVals{1};
                SetGO Asi1LedGreen,  ledVals{2};
                SetGO Asi1LedBlue,   ledVals{3};
                SetGO Asi1LedPeriod, ledVals{4};
                SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""setled""}" + ByteToStr(10\Char));
                RETURN;
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""setled"",""msg"":""invalid led params""}" + ByteToStr(10\Char));
        CASE "setdo":
            IF GetJsonStringVal(json, "name", name) AND GetJsonNumVal(json, "val", val) THEN
                IF val = 0 OR val = 1 THEN
                    TEST name
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
                        SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""setdo"",""msg"":""unknown signal""}" + ByteToStr(10\Char));
                        RETURN;
                    ENDTEST
                    SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""setdo""}" + ByteToStr(10\Char));
                    RETURN;
                ENDIF
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""setdo"",""msg"":""invalid signal params""}" + ByteToStr(10\Char));
        CASE "getvar":
            IF GetJsonStringVal(json, "name", name) THEN
                name := StrMap(name, "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
                IF name = "NTESTVAR" THEN
                    SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""getvar"",""val"":""" + NumToStr(nTestVar, 6) + """}" + ByteToStr(10\Char));
                ELSEIF name = "STESTMSG" THEN
                    SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""getvar"",""val"":""" + sTestMsg + """}" + ByteToStr(10\Char));
                ELSE
                    SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""getvar"",""msg"":""unknown var""}" + ByteToStr(10\Char));
                ENDIF
                RETURN;
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""getvar"",""msg"":""invalid var params""}" + ByteToStr(10\Char));
        CASE "setvar":
            IF GetJsonStringVal(json, "name", name) THEN
                varname := StrMap(name, "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
                IF varname = "NTESTVAR" THEN
                    IF GetJsonNumVal(json, "val", val) THEN
                        nTestVar := val;
                        SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""setvar""}" + ByteToStr(10\Char));
                        RETURN;
                    ENDIF
                ELSEIF varname = "STESTMSG" THEN
                    IF GetJsonStringVal(json, "val", valstr) THEN
                        sTestMsg := valstr;
                        SocketSend clientSocket \Str:=("{""status"":""ok"",""cmd"":""setvar""}" + ByteToStr(10\Char));
                        RETURN;
                    ENDIF
                ELSE
                    SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""setvar"",""msg"":""unknown var""}" + ByteToStr(10\Char));
                    RETURN;
                ENDIF
            ENDIF
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""setvar"",""msg"":""invalid var params""}" + ByteToStr(10\Char));
        DEFAULT:
            SocketSend clientSocket \Str:=("{""status"":""err"",""cmd"":""" + cmd + """,""msg"":""unsupported command""}" + ByteToStr(10\Char));
        ENDTEST
    ENDPROC


    ! Parse one command, run the routine, send the ack
    PROC Dispatch(string raw)
        VAR string cmd;
        VAR string rawclean;
        VAR num speedVal;
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
            pHome := CRobT(\Tool:=tool0 \WObj:=wobj1);
            SaveHome;
            SocketSend clientSocket \Str:=("OK:" + cmd + ByteToStr(10\Char));
        CASE "PING":
            SocketSend clientSocket \Str:=("OK:PING" + ByteToStr(10\Char));
        CASE "GETSPEED":
            ! Reads C_MOTSET.vel.oride -- the current VelSet override set by SPEEDnn (below).
            speedVal := C_MOTSET.vel.oride;
            SocketSend clientSocket \Str:=("VAL:" + NumToStr(speedVal, 2) + ByteToStr(10\Char));
        CASE "STOP":
            StopMove;
            ClearPath;
            StartMove;
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
        p := CRobT(\Tool:=tool0 \WObj:=wobj1);
        StopMove;
        ClearPath;
        StartMove;
        IF rot THEN
            TEST axis
            CASE "X": MoveJ \Conc, RelTool(p, 0, 0, 0 \Rx:=val), vJog, fine, tool0 \WObj:=wobj1;
            CASE "Y": MoveJ \Conc, RelTool(p, 0, 0, 0 \Ry:=val), vJog, fine, tool0 \WObj:=wobj1;
            CASE "Z": MoveJ \Conc, RelTool(p, 0, 0, 0 \Rz:=val), vJog, fine, tool0 \WObj:=wobj1;
            ENDTEST
        ELSE
            TEST axis
            CASE "X": MoveJ \Conc, Offs(p, val, 0, 0), vJog, fine, tool0 \WObj:=wobj1;
            CASE "Y": MoveJ \Conc, Offs(p, 0, val, 0), vJog, fine, tool0 \WObj:=wobj1;
            CASE "Z": MoveJ \Conc, Offs(p, 0, 0, val), vJog, fine, tool0 \WObj:=wobj1;
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
        MoveAbsJ \Conc, jt, vJog, fine, tool0 \WObj:=wobj1;
        RETURN TRUE;
    ENDFUNC

    ! Set the speed override (scales every move). Token: SPEEDnn (1..100).
    ! Uses VelSet, not SpeedRefresh -- confirmed live 2026-07-21 that SpeedRefresh only
    ! updates an ALREADY-EXECUTING move, so calling it here (before the next move even
    ! starts) has no real effect; see the JSON "speed" case above for the same fix.
    ! Returns FALSE (-> caller sends ERR) if it isn't a valid speed token.
    FUNC bool TrySpeed(string cmd)
        VAR num n;
        VAR num spd;
        n := StrLen(cmd);
        IF n < 6 RETURN FALSE;
        IF StrPart(cmd, 1, 5) <> "SPEED" RETURN FALSE;
        IF NOT StrToVal(StrPart(cmd, 6, n - 5), spd) RETURN FALSE;
        IF spd < 1 OR spd > 100 RETURN FALSE;
        VelSet spd, 5000;
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
            MoveL t, vGoto, fine, tool0 \WObj:=wobj1;
        ELSE
            MoveJ t, vGoto, fine, tool0 \WObj:=wobj1;
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
    ! MOTION ROUTINES
    ! -------------------------------------------------------

    PROC rGoHome()
        MoveJ pHome, v200, fine, tool0 \WObj:=wobj1;
    ENDPROC

    ! Absolute joint move. Token: MOVEJ<j1;j2;j3;j4;j5;j6> (degrees) for
    ! MoveAbsJ, or MOVEL<...> for a straight-line TCP path to the pose those
    ! joints describe (CalcRobT forward kinematics + MoveL - same singularity
    ! caveat as GOTOL). Returns FALSE if not a MOVEJ/MOVEL token or parse fails.
    FUNC bool TryMoveJ(string cmd)
        VAR num n;
        VAR num vals{6};
        VAR jointtarget jt;
        VAR bool linear;
        n := StrLen(cmd);
        IF n < 6 RETURN FALSE;
        IF StrPart(cmd, 1, 5) = "MOVEJ" THEN
            linear := FALSE;
        ELSEIF StrPart(cmd, 1, 5) = "MOVEL" THEN
            linear := TRUE;
        ELSE
            RETURN FALSE;
        ENDIF
        IF NOT ParseNums(StrPart(cmd, 6, n - 5), vals) RETURN FALSE;
        jt.robax := [vals{1}, vals{2}, vals{3}, vals{4}, vals{5}, vals{6}];
        jt.extax := [9E9, 9E9, 9E9, 9E9, 9E9, 9E9];
        SocketSend clientSocket \Str:=("OK:" + StrPart(cmd, 1, 5) + ByteToStr(10\Char));
        IF linear THEN
            MoveL CalcRobT(jt, tool0 \WObj:=wobj1), vGoto, zActive, tool0 \WObj:=wobj1;
        ELSE
            MoveAbsJ jt, vGoto, zActive, tool0 \WObj:=wobj1;
        ENDIF
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
    ! Goes through RAPID's SetDO. RWS can ALSO write signals (POST
    ! /rw/iosystem/signals/{name}/set-value - gofa-do-write's RWS transport),
    ! but only on signals whose Access Level is "All"; this socket path works
    ! regardless of Access Level, since RAPID always has Rapid access.
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
