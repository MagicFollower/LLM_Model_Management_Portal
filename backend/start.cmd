@echo off
chcp 65001 >nul
title ModelSpace Backend
echo ============================================
echo   ModelSpace 后端服务启动
echo   地址: http://127.0.0.1:8001
echo ============================================
echo.

REM 检查虚拟环境
if not exist ".venv\Scripts\python.exe" (
    echo [错误] 未找到虚拟环境，请先执行:
    echo   python -m venv .venv
    echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
    pause
    exit /b 1
)

REM 检查端口是否已被占用
netstat -ano | findstr ":8001 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [警告] 端口 8001 已被占用，可能已有服务在运行。
    echo         如需重启，请先运行 stop.cmd
    pause
    exit /b 1
)

echo [启动] 正在启动后端服务...
echo.
.venv\Scripts\python.exe run.py
