"""模型下载脚本

从 Hugging Face 下载 Embedding 模型到项目指定的缓存目录。
下载完成后可通过设置 MODEL_PATH 环境变量指向该目录，实现离线加载。

用法：
    python scripts/download_model.py
    python scripts/download_model.py --model-id BAAI/bge-small-zh-v1.5
    python scripts/download_model.py --cache-dir /path/to/cache
    python scripts/download_model.py --revision 7999e1d3
    python scripts/download_model.py --hf-endpoint https://hf-mirror.com
    python scripts/download_model.py --local-dir /path/to/local/model
"""
import argparse
import os
import sys
from pathlib import Path

# 将 backend 根目录加入 path，以便导入 app.config
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))

from app import config  # noqa: E402


# 下载后必须存在的关键文件（相对模型目录）
REQUIRED_FILES = [
    "config.json",
    "pytorch_model.bin",
    "vocab.txt",
    "tokenizer_config.json",
    "modules.json",
    "1_Pooling/config.json",
]


def get_cache_dir(override: str | None = None) -> Path:
    """获取模型缓存目录。

    优先级：CLI 参数 > 环境变量 HF_CACHE_DIR > 项目默认 backend/.cache/huggingface
    """
    if override:
        return Path(override).resolve()
    env_dir = os.environ.get("HF_CACHE_DIR")
    if env_dir:
        return Path(env_dir).resolve()
    return Path(config.CACHE_DIR).resolve()


def get_local_dir(override: str | None = None) -> Path | None:
    """获取模型本地目录（MODEL_PATH）。

    优先级：CLI 参数 > 环境变量 MODEL_PATH
    """
    if override:
        return Path(override).resolve()
    env_path = os.environ.get("MODEL_PATH")
    if env_path:
        return Path(env_path).resolve()
    return None


def download_model(
    model_id: str,
    cache_dir: Path,
    revision: str | None = None,
    hf_endpoint: str | None = None,
    local_dir: Path | None = None,
    force: bool = False,
) -> Path:
    """下载模型到指定目录。

    Args:
        model_id: Hugging Face 模型 ID（如 BAAI/bge-small-zh-v1.5）
        cache_dir: HF 缓存目录
        revision: Git revision（commit hash / tag / branch）
        hf_endpoint: HF 镜像地址
        local_dir: 直接下载到该目录（不使用 HF 缓存结构）
        force: 强制重新下载

    Returns:
        模型目录的绝对路径
    """
    from huggingface_hub import snapshot_download

    # 设置镜像
    if hf_endpoint:
        os.environ["HF_ENDPOINT"] = hf_endpoint

    cache_dir.mkdir(parents=True, exist_ok=True)

    kwargs: dict = {
        "repo_id": model_id,
        "repo_type": "model",
        "cache_dir": str(cache_dir),
        "force_download": force,
    }
    if revision:
        kwargs["revision"] = revision
    if local_dir:
        local_dir.mkdir(parents=True, exist_ok=True)
        kwargs["local_dir"] = str(local_dir)

    print(f"模型 ID:    {model_id}")
    print(f"缓存目录:   {cache_dir}")
    if revision:
        print(f"Revision:   {revision}")
    if hf_endpoint:
        print(f"HF 镜像:    {hf_endpoint}")
    if local_dir:
        print(f"本地目录:   {local_dir}")
    print()

    result_path = snapshot_download(**kwargs)
    result = Path(result_path).resolve()

    print(f"下载完成:   {result}")
    return result


def verify_model(model_dir: Path) -> list[str]:
    """验证模型目录包含所有必需文件。

    Returns:
        缺失文件列表（空列表表示验证通过）
    """
    missing = []
    for rel in REQUIRED_FILES:
        full = model_dir / rel
        if not full.exists():
            missing.append(rel)
    return missing


def find_model_in_cache(model_id: str, cache_dir: Path, revision: str | None = None) -> Path | None:
    """在 HF 缓存目录中查找已下载的模型。

    HF 缓存结构: cache_dir/models--{org}--{repo}/snapshots/{revision}/
    """
    org, repo = model_id.split("/", 1)
    models_dir = cache_dir / f"models--{org}--{repo}"
    if not models_dir.exists():
        return None

    snapshots_dir = models_dir / "snapshots"
    if not snapshots_dir.exists():
        return None

    if revision:
        target = snapshots_dir / revision
        if target.exists():
            return target
        return None

    # 无 revision 时返回最新的快照
    revisions = sorted(snapshots_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    if revisions:
        return revisions[0]
    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="下载 BGE Embedding 模型到项目缓存目录",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s                                    # 使用默认配置下载
  %(prog)s --model-id BAAI/bge-small-zh-v1.5  # 指定模型
  %(prog)s --revision 7999e1d3                # 固定版本
  %(prog)s --local-dir ./models/bge           # 下载到指定目录
  %(prog)s --hf-endpoint https://hf-mirror.com  # 使用镜像
  %(prog)s --verify-only                      # 仅验证已有模型
  %(prog)s --force                            # 强制重新下载
        """,
    )
    parser.add_argument(
        "--model-id",
        default=config.MODEL_ID,
        help=f"模型 ID（默认: {config.MODEL_ID}）",
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help=f"HF 缓存目录（默认: {config.CACHE_DIR}）",
    )
    parser.add_argument(
        "--revision",
        default=None,
        help="Git revision（commit hash / tag）",
    )
    parser.add_argument(
        "--hf-endpoint",
        default=os.environ.get("HF_ENDPOINT"),
        help="HF 镜像地址（默认: 官方）",
    )
    parser.add_argument(
        "--local-dir",
        default=None,
        help="直接下载到该目录（不使用 HF 缓存结构）",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="仅验证模型完整性，不下载",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="强制重新下载",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    cache_dir = get_cache_dir(args.cache_dir)
    local_dir = get_local_dir(args.local_dir)

    # 确定要验证的模型目录
    target_dir: Path | None = None

    if local_dir:
        target_dir = local_dir
    else:
        # 在 HF 缓存中查找
        target_dir = find_model_in_cache(args.model_id, cache_dir, args.revision)

    if args.verify_only:
        if target_dir is None:
            print(f"错误: 未找到模型 {args.model_id}（缓存: {cache_dir}）")
            print("请先运行下载命令。")
            return 1
        missing = verify_model(target_dir)
        if missing:
            print(f"验证失败: 缺失文件 {len(missing)} 个")
            for f in missing:
                print(f"  - {f}")
            return 1
        print(f"验证通过: {target_dir}")
        print(f"  关键文件: {', '.join(REQUIRED_FILES)}")
        return 0

    # 下载
    result = download_model(
        model_id=args.model_id,
        cache_dir=cache_dir,
        revision=args.revision,
        hf_endpoint=args.hf_endpoint,
        local_dir=local_dir,
        force=args.force,
    )

    # 验证
    missing = verify_model(result)
    if missing:
        print(f"\n警告: 缺失文件 {len(missing)} 个:")
        for f in missing:
            print(f"  - {f}")
        print("\n模型可能不完整，但 SentenceTransformer 可能仍可加载。")
        return 1

    print(f"\n验证通过: 所有 {len(REQUIRED_FILES)} 个关键文件存在。")
    print(f"\n使用方式:")
    print(f"  方式1（自动）: 不设置 MODEL_PATH，服务自动从缓存加载")
    print(f"  方式2（手动）: 设置 MODEL_PATH={result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
