@echo off
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --config "C:\Users\user\.cloudflared\config.yml" --loglevel info --logfile "C:\Users\user\.cloudflared\panel-debug.log" run
