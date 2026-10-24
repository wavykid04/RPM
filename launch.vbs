Set ws = CreateObject("WScript.Shell")
ws.Run "cmd /c cd /d """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & """ && npm start", 0, False
