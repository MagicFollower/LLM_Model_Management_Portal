@echo off
chcp 65001 >nul
title ModelSpace Frontend Stop
echo ============================================
echo   ModelSpace 前端服务停止
echo ============================================
echo.

REM 查找占用 5173 端口的进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    echo [停止] 正在终止进程 PID=%%a ...
    taskkill /PID %%a /F >nul 2>&1
    if !errorlevel!==0 (
        echo [完成] 前端服务已停止。
    ) else (
        echo [错误] 无法终止进程 %%a，请以管理员身份运行。
    )
    goto :done
)

echo [信息] 端口 5173 无服务运行，无需停止。

:done
echo.
pause
