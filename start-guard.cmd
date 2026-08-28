@echo off
chcp 65001 >nul
rem 一键管理员终端式守护: 双击后自动请求 UAC 并以管理员运行 DSH, 崩溃后 3 秒自动重启
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 正在请求管理员权限...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
title dsh web 守护启动器 (崩溃自动重启, Ctrl+C 退出)
echo [dsh-crash-guard] 守护模式: dsh web 崩溃后 3 秒自动重启... (Ctrl+C 停止)
:loop
set HTTP_PROXY=http://127.0.0.1:7891
set HTTPS_PROXY=http://127.0.0.1:7891
set ALL_PROXY=http://127.0.0.1:7891
dsh web
echo [dsh-crash-guard] dsh web 已退出 (code %errorlevel%), 3 秒后重启... (Ctrl+C 停止)
timeout /t 3 >nul
goto loop
