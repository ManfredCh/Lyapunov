"""Darwin 的 tokenizers 0.12.1 构建叶；模型、SDK 及运行协议不变。"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile


def main():
    try:
        import tokenizers
        if tokenizers.__version__ == "0.12.1":
            print("tokenizers 0.12.1 已可导入，复用当前隔离前缀")
            return
    except ImportError:
        pass
    build()


def build():
    scratch = Path(sys.argv[1]).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    origin = json.loads((Path(__file__).parent / "SOURCE.json").read_text())
    pip = [sys.executable, "-m", "pip", "--isolated"]
    network = ["--index-url", "https://pypi.org/simple", "--timeout", "60", "--retries", "3"]
    # 下载／缓存／编译继续交给原 pip，不另写下载器；官方 sdist 没附 Cargo.lock。
    subprocess.run(pip + ["download", "--no-deps", "--no-binary=:all:", "--dest", str(scratch)] + network + ["tokenizers==0.12.1"], check=True)
    archive = scratch / origin["sdist"]["filename"]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != origin["sdist"]["sha256"]:
        raise RuntimeError("tokenizers 官方 sdist 校验失败，保留文件并停止")
    lock = Path(__file__).parent / "Cargo.lock"
    if hashlib.sha256(lock.read_bytes()).hexdigest() != origin["cargoLock"]["sha256"]:
        raise RuntimeError("tokenizers 同版官方 Cargo.lock 校验失败")
    with tempfile.TemporaryDirectory(prefix="tokenizers-build-", dir=str(scratch)) as directory:
        # 已核对官方固定 sdist；只补同版上游锁，Rust 源码不改。
        with tarfile.open(str(archive)) as source:
            source.extractall(directory)
        project = Path(directory) / "tokenizers-0.12.1"
        shutil.copyfile(lock, project / "Cargo.lock")
        subprocess.run(pip + ["install", "--no-deps", "--use-pep517"] + network + [str(project)], check=True)
    subprocess.run([sys.executable, "-c", "import tokenizers; assert tokenizers.__version__ == '0.12.1'"], check=True)


if __name__ == "__main__":
    main()
