@echo off
chcp 65001 >nul
title ModelSpace 全服务停止
echo ============================================
echo   ModelSpace 一键停止（后端 + 前端）
echo ============================================
echo.

REM 停止后端
echo [1/2] 停止后端服务 (端口 8001)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8001 " ^| findstr "LISTENING"') do (
    echo       终止 PID=%%a
    taskkill /PID %%a /F >nul 2>&1
)

REM 停止前端
echo [2/2] 停止前端服务 (端口 5173)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    echo       终止 PID=%%a
    taskkill /PID %%a /F >nul 2>&1
)

echo.
echo [完成] 所有服务已停止。
echo.
pause
