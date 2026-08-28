@echo off
chcp 65001 >nul
title dsh web 守护启动器 (崩溃自动重启, Ctrl+C 退出)
echo [dsh-crash-guard] 守护模式: dsh web 崩溃后 3 秒自动重启...
:loop
set HTTP_PROXY=http://127.0.0.1:7891
set HTTPS_PROXY=http://127.0.0.1:7891
set ALL_PROXY=http://127.0.0.1:7891
dsh web
echo [dsh-crash-guard] dsh web 已退出 (code %errorlevel%), 3 秒后重启... (Ctrl+C 停止)
timeout /t 3 >nul
goto loop
