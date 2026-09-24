@echo off
chcp 65001 >nul
title ModelSpace 全服务启动
echo ============================================
echo   ModelSpace 一键启动（后端 + 前端）
echo   后端: http://127.0.0.1:8001
echo   前端: http://localhost:5173
echo ============================================
echo.

REM 启动后端（新窗口）
echo [1/2] 启动后端服务...
start "ModelSpace Backend" cmd /k "cd /d "%~dp0backend" && start.cmd"
timeout /t 3 /nobreak >nul

REM 启动前端（新窗口）
echo [2/2] 启动前端服务...
start "ModelSpace Frontend" cmd /k "cd /d "%~dp0frontend" && start.cmd"

echo.
echo [完成] 两个服务已在新窗口中启动。
echo        关闭服务请运行 stop-all.cmd
echo.
pause
