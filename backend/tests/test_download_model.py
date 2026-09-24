"""模型下载脚本测试"""
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# 确保可以导入 scripts 目录下的模块
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

from download_model import (  # noqa: E402
    get_cache_dir,
    get_local_dir,
    verify_model,
    find_model_in_cache,
    build_parser,
    main,
    REQUIRED_FILES,
)


@pytest.fixture
def tmp_cache(tmp_path):
    """创建临时缓存目录"""
    return tmp_path / "cache"


@pytest.fixture
def tmp_model(tmp_path):
    """创建临时模型目录（包含所有必需文件）"""
    model_dir = tmp_path / "model"
    for rel in REQUIRED_FILES:
        full = model_dir / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text("{}")
    return model_dir


class TestGetCacheDir:
    """缓存目录解析测试"""

    def test_default(self, tmp_cache):
        """默认使用 config.CACHE_DIR"""
        with patch("download_model.config") as mock_config:
            mock_config.CACHE_DIR = str(tmp_cache)
            result = get_cache_dir()
        assert result == tmp_cache.resolve()

    def test_cli_override(self, tmp_cache):
        """CLI 参数优先"""
        result = get_cache_dir(str(tmp_cache))
        assert result == tmp_cache.resolve()

    def test_env_override(self, tmp_cache, monkeypatch):
        """环境变量 HF_CACHE_DIR 作为第二优先级"""
        monkeypatch.setenv("HF_CACHE_DIR", str(tmp_cache))
        result = get_cache_dir()
        assert result == tmp_cache.resolve()

    def test_cli_over_env(self, tmp_cache, monkeypatch):
        """CLI 参数优先于环境变量"""
        monkeypatch.setenv("HF_CACHE_DIR", "/other/path")
        result = get_cache_dir(str(tmp_cache))
        assert result == tmp_cache.resolve()


class TestGetLocalDir:
    """本地模型目录解析测试"""

    def test_default_none(self):
        """未设置时返回 None"""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MODEL_PATH", None)
            result = get_local_dir()
        assert result is None

    def test_cli_override(self, tmp_path):
        """CLI 参数"""
        result = get_local_dir(str(tmp_path))
        assert result == tmp_path.resolve()

    def test_env_override(self, tmp_path, monkeypatch):
        """环境变量 MODEL_PATH"""
        monkeypatch.setenv("MODEL_PATH", str(tmp_path))
        result = get_local_dir()
        assert result == tmp_path.resolve()

    def test_cli_over_env(self, tmp_path, monkeypatch):
        """CLI 优先于环境变量"""
        monkeypatch.setenv("MODEL_PATH", "/other/path")
        result = get_local_dir(str(tmp_path))
        assert result == tmp_path.resolve()


class TestVerifyModel:
    """模型完整性验证测试"""

    def test_complete_model(self, tmp_model):
        """所有必需文件存在"""
        missing = verify_model(tmp_model)
        assert missing == []

    def test_missing_config(self, tmp_path):
        """缺少 config.json"""
        model_dir = tmp_path / "partial"
        for rel in REQUIRED_FILES:
            if rel == "config.json":
                continue
            full = model_dir / rel
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text("{}")
        missing = verify_model(model_dir)
        assert "config.json" in missing
        assert len(missing) == 1

    def test_missing_pooling(self, tmp_path):
        """缺少 1_Pooling/config.json"""
        model_dir = tmp_path / "no_pooling"
        for rel in REQUIRED_FILES:
            if rel == "1_Pooling/config.json":
                continue
            full = model_dir / rel
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text("{}")
        missing = verify_model(model_dir)
        assert "1_Pooling/config.json" in missing

    def test_empty_directory(self, tmp_path):
        """空目录"""
        model_dir = tmp_path / "empty"
        model_dir.mkdir()
        missing = verify_model(model_dir)
        assert len(missing) == len(REQUIRED_FILES)

    def test_nonexistent_directory(self, tmp_path):
        """不存在的目录"""
        missing = verify_model(tmp_path / "no_such_dir")
        assert len(missing) == len(REQUIRED_FILES)


class TestFindModelInCache:
    """HF 缓存中查找模型测试"""

    def test_model_not_downloaded(self, tmp_cache):
        """缓存中无模型"""
        result = find_model_in_cache("BAAI/bge-small-zh-v1.5", tmp_cache)
        assert result is None

    def test_model_found(self, tmp_cache):
        """找到已下载的模型"""
        # 模拟 HF 缓存结构
        model_dir = tmp_cache / "models--BAAI--bge-small-zh-v1.5" / "snapshots" / "abc123"
        model_dir.mkdir(parents=True)
        (model_dir / "config.json").write_text("{}")

        result = find_model_in_cache("BAAI/bge-small-zh-v1.5", tmp_cache)
        assert result == model_dir.resolve()

    def test_model_found_with_revision(self, tmp_cache):
        """指定 revision 查找"""
        target = tmp_cache / "models--BAAI--bge-small-zh-v1.5" / "snapshots" / "7999e1d3"
        other = tmp_cache / "models--BAAI--bge-small-zh-v1.5" / "snapshots" / "old12345"
        target.mkdir(parents=True)
        other.mkdir(parents=True)

        result = find_model_in_cache("BAAI/bge-small-zh-v1.5", tmp_cache, revision="7999e1d3")
        assert result == target.resolve()

    def test_revision_not_found(self, tmp_cache):
        """指定 revision 但不存在"""
        model_dir = tmp_cache / "models--BAAI--bge-small-zh-v1.5" / "snapshots" / "abc123"
        model_dir.mkdir(parents=True)

        result = find_model_in_cache("BAAI/bge-small-zh-v1.5", tmp_cache, revision="nonexistent")
        assert result is None

    def test_latest_snapshot(self, tmp_cache):
        """无 revision 时返回最新的快照"""
        old = tmp_cache / "models--BAAI--bge-small-zh-v1.5" / "snapshots" / "old"
        new = tmp_cache / "models--BAAI--bge-small-zh-v1.5" / "snapshots" / "new"
        old.mkdir(parents=True)
        new.mkdir(parents=True)
        # 让 new 更新
        import time
        time.sleep(0.05)
        (new / "touch").write_text("")

        result = find_model_in_cache("BAAI/bge-small-zh-v1.5", tmp_cache)
        assert result == new.resolve()


class TestBuildParser:
    """CLI 参数解析测试"""

    def test_defaults(self):
        """默认参数"""
        parser = build_parser()
        args = parser.parse_args([])
        assert args.model_id == "BAAI/bge-small-zh-v1.5"
        assert args.cache_dir is None
        assert args.revision is None
        assert args.local_dir is None
        assert args.verify_only is False
        assert args.force is False

    def test_all_options(self):
        """所有选项"""
        parser = build_parser()
        args = parser.parse_args([
            "--model-id", "test/model",
            "--cache-dir", "/tmp/cache",
            "--revision", "abc123",
            "--hf-endpoint", "https://mirror.com",
            "--local-dir", "/tmp/model",
            "--verify-only",
            "--force",
        ])
        assert args.model_id == "test/model"
        assert args.cache_dir == "/tmp/cache"
        assert args.revision == "abc123"
        assert args.hf_endpoint == "https://mirror.com"
        assert args.local_dir == "/tmp/model"
        assert args.verify_only is True
        assert args.force is True


class TestMainVerifyOnly:
    """main() verify-only 模式测试"""

    def test_verify_success(self, tmp_model, capsys):
        """验证通过"""
        rc = main(["--verify-only", "--local-dir", str(tmp_model)])
        assert rc == 0
        out = capsys.readouterr().out
        assert "验证通过" in out

    def test_verify_missing(self, tmp_path, capsys):
        """验证失败（文件缺失）"""
        empty = tmp_path / "empty_model"
        empty.mkdir()
        rc = main(["--verify-only", "--local-dir", str(empty)])
        assert rc == 1
        out = capsys.readouterr().out
        assert "验证失败" in out

    def test_verify_not_found(self, tmp_cache, capsys):
        """模型不存在"""
        rc = main(["--verify-only", "--cache-dir", str(tmp_cache)])
        assert rc == 1
        out = capsys.readouterr().out
        assert "未找到模型" in out


class TestMainDownload:
    """main() 下载模式测试（mock snapshot_download）"""

    def test_download_and_verify(self, tmp_cache, tmp_model, capsys):
        """下载成功并验证通过"""
        with patch("huggingface_hub.snapshot_download", return_value=str(tmp_model)):
            rc = main([
                "--cache-dir", str(tmp_cache),
                "--model-id", "BAAI/bge-small-zh-v1.5",
            ])
        assert rc == 0
        out = capsys.readouterr().out
        assert "验证通过" in out
        assert "所有" in out

    def test_download_missing_files(self, tmp_cache, tmp_path, capsys):
        """下载后文件不完整"""
        partial = tmp_path / "partial_model"
        partial.mkdir()
        # 只创建一个文件
        (partial / "config.json").write_text("{}")

        with patch("huggingface_hub.snapshot_download", return_value=str(partial)):
            rc = main([
                "--cache-dir", str(tmp_cache),
                "--model-id", "BAAI/bge-small-zh-v1.5",
            ])
        assert rc == 1
        out = capsys.readouterr().out
        assert "警告" in out
        assert "缺失文件" in out

    def test_download_with_revision(self, tmp_cache, tmp_model, capsys):
        """带 revision 下载"""
        with patch("huggingface_hub.snapshot_download", return_value=str(tmp_model)) as mock_dl:
            rc = main([
                "--cache-dir", str(tmp_cache),
                "--revision", "7999e1d3",
            ])
        assert rc == 0
        # 验证 revision 被传递
        call_kwargs = mock_dl.call_args.kwargs
        assert call_kwargs["revision"] == "7999e1d3"

    def test_download_with_hf_endpoint(self, tmp_cache, tmp_model, monkeypatch, capsys):
        """带 HF 镜像下载"""
        with patch("huggingface_hub.snapshot_download", return_value=str(tmp_model)):
            rc = main([
                "--cache-dir", str(tmp_cache),
                "--hf-endpoint", "https://hf-mirror.com",
            ])
        assert rc == 0
        assert os.environ.get("HF_ENDPOINT") == "https://hf-mirror.com"

    def test_download_with_local_dir(self, tmp_path, tmp_model, capsys):
        """下载到指定本地目录"""
        local = tmp_path / "my_model"
        with patch("huggingface_hub.snapshot_download", return_value=str(tmp_model)):
            rc = main([
                "--local-dir", str(local),
            ])
        assert rc == 0

    def test_download_force(self, tmp_cache, tmp_model, capsys):
        """强制重新下载"""
        with patch("huggingface_hub.snapshot_download", return_value=str(tmp_model)) as mock_dl:
            rc = main([
                "--cache-dir", str(tmp_cache),
                "--force",
            ])
        assert rc == 0
        call_kwargs = mock_dl.call_args.kwargs
        assert call_kwargs["force_download"] is True
