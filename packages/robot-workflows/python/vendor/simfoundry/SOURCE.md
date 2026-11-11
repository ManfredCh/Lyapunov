# SimFoundry 网格转 USD 来源

固定 NVIDIA SimFoundry 提交 `9e34ebefcd020583fbb755a8b57268dce78eca26`。三份 Python 文件和上游 `LICENSE` 按字节保留，许可为 Apache-2.0。运行时由所选解释器提供 NumPy、trimesh、OpenUSD 和 Pillow。

| 本地文件 | 上游路径 | Upstream blob SHA-1 | SHA-256 |
| --- | --- | --- | --- |
| `asset_import.py` | [`scripts/interactive/light_editor/asset_import.py`](https://github.com/NVlabs/SimFoundry/blob/9e34ebefcd020583fbb755a8b57268dce78eca26/scripts/interactive/light_editor/asset_import.py) | `908b24e9e3a11af9a071203a9301380ca4ce211f` | `68747dbbdcd2bb94e9e192467138fa0ada744fe2d0748da7316c92e252f997f7` |
| `scene_io.py` | [`scripts/interactive/light_editor/scene_io.py`](https://github.com/NVlabs/SimFoundry/blob/9e34ebefcd020583fbb755a8b57268dce78eca26/scripts/interactive/light_editor/scene_io.py) | `73e4b804b3033dadecd16ce72aa6313e48ad57a6` | `72f02cf2497642ee045e54a45536a0fa55f1735c9df9db2d321e7dbd498a694c` |
| `usd_cache.py` | [`scripts/interactive/light_editor/usd_cache.py`](https://github.com/NVlabs/SimFoundry/blob/9e34ebefcd020583fbb755a8b57268dce78eca26/scripts/interactive/light_editor/usd_cache.py) | `8e91b5dbf476d082636958fe1257f1cfd4ec059a` | `635d27a9f960f26735cdd4baa415f0c9e76ed8089f901b0fdb4bb0f6d45b1bac` |
| `LICENSE` | [`LICENSE`](https://github.com/NVlabs/SimFoundry/blob/9e34ebefcd020583fbb755a8b57268dce78eca26/LICENSE) | `001a3281169d6ade30cd1a44544029254ba490a8` | `4f321b887d0350e672e06c8a8bc85cff17ee2d1f3c360617079041ceee324c81` |

`prepare_simfoundry_usd.py` 调用 `asset_import.convert_mesh`。该文件从 `scene_io.py` 读取质量范围与异常类型，`scene_io.py` 引用 `usd_cache.py`。实际改动集中在本项目的派生层，只处理上游输出的可搬迁材质闭包。
