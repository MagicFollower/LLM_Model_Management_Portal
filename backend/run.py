"""启动入口"""
from dotenv import load_dotenv

# 在导入 config 前加载 .env，使 os.environ 能读到环境变量
load_dotenv()

import uvicorn

from app import config

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )
