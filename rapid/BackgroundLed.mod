MODULE BackgroundLed

    ! -------------------------------------------------------
    ! Background LED server for node-red-contrib-abb-gofa.
    !
    ! Runs in its OWN RAPID task (SEMISTATIC/STATIC, e.g. "T_LED") —
    ! NOT the T_ROB1 motion task that MainModule.mod runs in. The
    ! whole point: T_ROB1 gets stopped by gofa-leadthrough's teach
    ! workflow (POST /rw/rapid/execution/stop) before hand-guiding,
    ! which kills MainModule.mod's socket server along with it. A
    ! SEMISTATIC/STATIC task is not part of that Program Stop/Start
    ! cycle, so this server keeps answering SETLED/RESETLED the
    ! whole time T_ROB1 is down. Requires RobotWare Multitasking
    ! [3114-1] (licensed on this controller) plus a one-time
    ! RobotStudio task setup — see CLAUDE.md's "Background LED task"
    ! section. NOT YET LIVE-VERIFIED that execution/stop actually
    ! leaves a SEMISTATIC task running — test this before relying on
    ! it for a real teach session.
    !
    ! Deliberately a separate module/task rather than folding into
    ! MainModule.mod, same reasoning as MainModuleEGM.mod: a second
    ! PROC main() can't coexist with MainModule's in the same task,
    ! and the whole point here is a task T_ROB1's stop can't touch.
    !
    ! Same JSON wire protocol as MainModule.mod, restricted to the
    ! only commands that need to survive T_ROB1 being stopped:
    !   {"cmd":"ping"}                         -> {"status":"ok","cmd":"ping"}
    !   {"cmd":"setled","val":[r,g,b,period]}  -> {"status":"ok","cmd":"setled"}
    !   {"cmd":"resetled"}                      -> {"status":"ok","cmd":"resetled"}
    !
    ! SERVER_IP must be a real configured interface address (RAPID
    ! cannot bind a wildcard) — same caveat as MainModule.mod. The
    ! palette's upload paths rewrite it to the robot's IP automatically.
    ! -------------------------------------------------------

    CONST string SERVER_IP       := "192.168.1.103";
    CONST num    LED_SERVER_PORT := 1026;

    VAR socketdev ledServerSocket;
    VAR socketdev ledClientSocket;
    VAR string    rxStr;

    PROC main()
        WHILE TRUE DO
            ServeForever;
            WaitTime 1;
        ENDWHILE
    ENDPROC

    PROC ServeForever()
        SocketCreate ledServerSocket;
        SocketBind ledServerSocket, SERVER_IP, LED_SERVER_PORT;
        SocketListen ledServerSocket;
        WHILE TRUE DO
            SocketAccept ledServerSocket, ledClientSocket \Time:=WAIT_MAX;
            ServeClient;
        ENDWHILE
    ERROR
        SocketClose ledClientSocket;
        SocketClose ledServerSocket;
        RETURN;
    ENDPROC

    PROC ServeClient()
        WHILE TRUE DO
            SocketReceive ledClientSocket \Str:=rxStr \Time:=WAIT_MAX;
            IF StrLen(rxStr) > 0 THEN
                DispatchJson rxStr;
            ENDIF
        ENDWHILE
    ERROR
        IF ERRNO = ERR_SOCK_CLOSED THEN
            SocketClose ledClientSocket;
            RETURN;
        ENDIF
        RETRY;
    ENDPROC

    PROC DispatchJson(string json)
        VAR string cmd := "";
        VAR num ledVals{4};

        IF NOT GetJsonStringVal(json, "cmd", cmd) THEN
            SocketSend ledClientSocket \Str:=("{""status"":""err"",""cmd"":""unknown"",""msg"":""invalid json command""}" + ByteToStr(10\Char));
            RETURN;
        ENDIF

        TEST cmd
        CASE "ping":
            SocketSend ledClientSocket \Str:=("{""status"":""ok"",""cmd"":""ping""}" + ByteToStr(10\Char));
        CASE "resetled":
            SetGO Asi1LedRed,    0;
            SetGO Asi1LedGreen,  255;
            SetGO Asi1LedBlue,   0;
            SetGO Asi1LedPeriod, 0;
            SocketSend ledClientSocket \Str:=("{""status"":""ok"",""cmd"":""resetled""}" + ByteToStr(10\Char));
        CASE "setled":
            IF GetJsonNumArray(json, "val", ledVals) THEN
                SetGO Asi1LedRed,    ledVals{1};
                SetGO Asi1LedGreen,  ledVals{2};
                SetGO Asi1LedBlue,   ledVals{3};
                SetGO Asi1LedPeriod, ledVals{4};
                SocketSend ledClientSocket \Str:=("{""status"":""ok"",""cmd"":""setled""}" + ByteToStr(10\Char));
                RETURN;
            ENDIF
            SocketSend ledClientSocket \Str:=("{""status"":""err"",""cmd"":""setled"",""msg"":""invalid led params""}" + ByteToStr(10\Char));
        DEFAULT:
            SocketSend ledClientSocket \Str:=("{""status"":""err"",""cmd"":""" + cmd + """,""msg"":""unsupported command""}" + ByteToStr(10\Char));
        ENDTEST
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

ENDMODULE
