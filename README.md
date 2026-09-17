# 云胶片逐帧导出（Cloud Film Frame Export）

> 在云端阅片器里**逐帧取回本人检查的未压缩原始影像**，并在浏览器内直接拼装成**标准 DICOM 文件**（`.dcm`）。全程本地完成，不上传任何数据到第三方。

一个 Tampermonkey 用户脚本。适用场景：平台的阅片器没有可用的导出功能 —— 自带的「下载」按钮被隐藏，整份打包接口点击后报「获取数据失败」。

![合成体模三窗位预览](samples/preview.png)

> 上图是仓库内的**合成 CT 体模**（由 `tools/make_sample.py` 现场生成），不是真实患者影像。本仓库不包含任何真实病例数据。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [特性](#特性)
- [安装](#安装)
- [使用](#使用)
- [产出说明](#产出说明)
- [技术原理：三个关键点](#技术原理三个关键点)
- [生成的 DICOM 包含什么](#生成的-dicom-包含什么)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [免责声明](#免责声明)
- [开发与验证](#开发与验证)
- [License](#license)

---

## 它解决什么问题

很多云胶片平台的阅片器**只能看、不能存**：

| 现象 | 原因 |
|---|---|
| 页面右上角没有「下载」按钮 | URL 里的 `hidebtns` 参数把按钮隐藏了 |
| 点下载报「获取数据失败，请检查网络后重试」 | 后端打包服务未配置（`storageNode` 为空），与你的网络无关 |
| 用浏览器另存为，得到的是一张低清截图 | 屏幕像素 ≠ 影像像素 |

但阅片器**自己**必须能读到影像 —— 否则它显示不出来。本脚本就是复用阅片器读取影像的那条通道，把每一帧的完整像素取回来。

关键前提：服务端当前以**逐帧未压缩原始像素**返回（`compressionFormat = 1`）。响应体就是裸的 16 位灰度像素，不经过任何有损压缩；同时响应头 `X-ImageFrame` 会带回该帧的几何与灰度元数据。**两者合起来就足以还原一份标准 DICOM**，所以不需要任何后续转换软件。

## 特性

- **无损**：拿到的是未压缩的原始像素，HU 值可精确换算，无 JPEG 压缩痕迹
- **直出 DICOM**：浏览器内拼装 Part 10 / Explicit VR LE 文件，Windows / macOS 任意 DICOM 查看器可直接打开
- **像素长度强制校验**：实际字节数必须等于 `rows × columns × 2`，不匹配就重试并记入失败清单，**绝不悄悄写出错位的坏文件**
- **可断点续传**：勾选「跳过已存在」后重跑即可从断点继续；会话失效会立即中止并提示，不会静默产出空文件
- **零依赖、零上传**：`@grant none`，不请求任何额外权限，不向任何服务器发送数据
- **单文件**：整个工具就是一个 `.user.js`

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开本仓库的 [`cloudfilm-frame-export.user.js`](./cloudfilm-frame-export.user.js)，点 **Raw**，Tampermonkey 会弹出安装页
   （或把文件下载到本地后拖进浏览器）
3. 确认安装

> ⚠️ **必须使用 Chromium 内核的桌面浏览器（Edge / Chrome）。**
> 脚本通过 File System Access API（`showDirectoryPicker`）直接往你选的文件夹写文件。
> Firefox / Safari 不支持该 API，脚本会明确提示而不是静默失败。

## 使用

1. 打开阅片器页面（确保影像已经显示出来），右上角会出现**「逐帧导出原始影像」**面板
2. 面板会列出本次检查的所有序列和帧数，**勾选你要导出的序列**（默认全选）
3. 先点 **「自检（取 1 帧）」** —— 确认取帧正常再批量导出，避免白跑
4. 选好**导出格式**，点 **「选取目录并导出」**，选一个**空文件夹**
5. 等待完成。导出期间**不要刷新页面、不要关闭标签页**

面板上的其他选项：

| 选项 | 说明 |
|---|---|
| 导出格式 | `.dcm` / `.raw + .json` / 两种都要 |
| 跳过已存在的文件 | 断点续传用；重跑时已导出的帧直接跳过 |
| 保存 `_帧元数据.json` | 写一份整份导出的帧清单，便于核对与后处理 |
| 并发数 | 请求并发，默认 3，范围 1–8。调太高可能被服务端限流 |

## 产出说明

导出目录结构：

```
你选的文件夹/
├── 01_<序列描述>_SN<序列号>/
│   ├── 0001.dcm
│   ├── 0002.dcm
│   └── ...
├── 02_<序列描述>_SN<序列号>/
│   └── ...
├── _帧元数据.json          （可选）
└── _导出失败清单.txt        （仅在有失败帧时生成）
```

三种格式：

| 格式 | 内容 | 用途 |
|---|---|---|
| `.dcm` | 完整 DICOM Part 10 文件 | 直接用 DICOM 查看器打开；**推荐** |
| `.raw` | 裸的 16 位小端像素，长度 = `rows × columns × 2` | 自己写脚本处理 |
| `.json` | 同帧元数据 sidecar（含 `serverHeader` 原始响应头） | 把 `.raw` 还原成 DICOM 所需的一切几何信息都在这里 |

**体积提醒**：未压缩意味着每帧固定 `宽 × 高 × 2` 字节。一份 512×512 的 CT 每帧 **512 KB**，例如一个含 7 个序列、约 2700 帧的胸部增强 CT 大约 **1.4 GB**。导出前请留足磁盘空间。

## 技术原理：三个关键点

### 1. 帧地址与分辨率档

```
/imageservice/api/image/dicom/{studyId}/{imageId}/{frame}/{level}?ck={cacheKey}
```

- `studyId` 必须取阅片器内部 `image().studyId`（真实 StudyInstanceUID），不是 URL 上的扩展 ID，否则 500
- 末段 `level` 是分辨率档，**必须用 `0`**

实测（某 Scout 序列，全分辨率 1141 × 768）：

| `level` | 返回字节 | 实际像素尺寸 | 像素数占比 |
|---|---|---|---|
| **0** | 1,752,576 | 1141 × 768 | 1/1 |
| 1 | 437,760 | 570 × 384 | 1/4 |
| 2 | 109,440 | 285 × 192 | 1/16 |
| 3 | 27,264 | 142 × 96 | 1/64 |

### 2. 一个必须防的坑：头里的尺寸是假的

低档位返回的 `X-ImageFrame` 里，`rows` / `columns` **仍然写着原始尺寸**（1141 × 768），但实际像素只有 1/4、1/16、1/64。

如果照着头部字段去解释像素，会得到一个**行错位、看起来还有点像图**的坏文件 —— 这种错误最难发现。

因此脚本强制校验 `实际字节数 === rows × columns × 2`，不匹配就重试，`MAX_TRIES` 次后记入 `_导出失败清单.txt`。

### 3. 空帧与会话失效

- **空帧**：服务端偶发返回 528 字节的常数像素「合法」JP2/像素块。脚本按字节数（阈值 8192）判定为异常并自动重试 3 次。
- **会话失效**：长时间导出时登录 cookie 可能过期，此时所有帧会一起静默失败。脚本检测到 401/403 会**立即中止整个任务**并提示刷新重登，而不是继续写出一堆坏文件。重新运行 + 勾选「跳过已存在」即可续传。

## 生成的 DICOM 包含什么

文件为 **Part 10 / Explicit VR Little Endian**，128 字节前导 + `DICM` + 元信息 + 数据集。

| 类别 | 标签 |
|---|---|
| SOP | `SOPClassUID`, `SOPInstanceUID`, `StudyInstanceUID`, `SeriesInstanceUID`, `FrameOfReferenceUID` |
| 患者 | `PatientName`(PN, UTF-8), `PatientID`, `PatientSex` |
| 检查 | `StudyDate`, `SeriesDate`, `AcquisitionDate`, `StudyTime`, 系列/检查描述, `AccessionNumber`, `Modality` |
| 几何 | `Rows`, `Columns`, `ImagePositionPatient`, `ImageOrientationPatient`, `SliceLocation`, `PixelSpacing`, `SliceThickness`, `SpacingBetweenSlices`, `InstanceNumber` |
| 灰度 | `BitsAllocated/Stored/HighBit`, `PixelRepresentation`, `RescaleIntercept`, `RescaleSlope`, `RescaleType=HU`, `WindowCenter`, `WindowWidth`, `PhotometricInterpretation` |
| 像素 | `PixelData` (OW) |

两个刻意的设计：

- **`ImageType` 写作 `DERIVED\SECONDARY\<方位>`** —— 诚实标明这是从影像服务重建出来的派生影像，不是采集端原始的 SOP 实例。
- **`SliceLocation` 由 `ImagePositionPatient` 在层面法向上的投影算出**，而不是照抄服务端的值。3D 重建软件会交叉核对这两项，两者自洽才不会出错。

**缺什么**：原始文件里的私有 tag、设备采集参数（kVp / mAs / 曝光时间等，服务端返回的就是 0）、以及 DICOMDIR 目录文件。

## 常见问题

**Q：导出后图片全是黑的 / 一堆噪点？**
先确认导的是 `.dcm` 而不是把 `.raw` 当图片打开。`.raw` 没有任何文件头，必须配同名 `.json` 才能解释。

**Q：一个序列里部分帧失败了怎么办？**
看 `_导出失败清单.txt`。重跑一次并保持「跳过已存在」勾选，脚本会只重试缺的那些。

**Q：中途提示「登录会话已失效」？**
刷新页面重新登录，回到阅片器，再点导出并保持「跳过已存在」勾选，即可从断点续传。

**Q：能把导出的文件发给别人吗？**
⚠️ **导出的 `.dcm` 里带着患者姓名和患者 ID。** 发给别人前请先去掉标识信息（任何 DICOM 查看器或 `gdcmanon` 之类的工具都能做），否则等于泄露个人敏感信息。

**Q：这份 DICOM 能直接拿去做三维重建 / 测量吗？**
可以。像素间距、层间距、方向余弦、`SliceLocation` 都已写入且互相自洽，3D 重建的比例是正确的。

**Q：体积为什么这么大？**
因为是无损：每帧固定 `宽 × 高 × 2` 字节，一个字节都没压。这正是它比截图和压缩格式有价值的地方。

## 已知限制

- 仅处理 **CT / MR 这类单帧灰度**（`MONOCHROME2`）影像；彩色、多帧、压缩传输语法的 DICOM 不在支持范围
- 依赖平台内部接口与页面全局变量，**平台改版会导致脚本失效**（会在面板上直接报错，不会静默出错）
- 需要 Chromium 内核桌面浏览器（见[安装](#安装)）
- 只做导出，不做图像处理。若需要把导出的影像批量转成 JPG / PNG（换窗位、放大、多窗拼图），需另配工具，暂未开源

## 免责声明

- 本工具仅用于**取回你自己，或已获得明确授权的人**的医学影像。个人依法有权获取本人的病历资料，但**传播他人影像属于侵犯个人隐私**，请勿这样做。
- 使用本工具即表示你自行承担因使用而产生的全部责任，包括但不限于平台服务条款的合规性。
- 导出的影像**仅供个人留存与就医参考，不能作为诊断依据**。任何诊断请以医疗机构出具的正式报告为准。
- 本软件按「原样」提供，不附带任何明示或暗示的担保。

## 开发与验证

仓库里的样本全部是**合成体模**，不含任何真实病例数据。两个辅助脚本在 `tools/`：

```bash
# 1. 生成合成 CT 体模 → samples/synthetic_ct.raw + .json + preview.png
python tools/make_sample.py

# 2. 用「脚本自身的编码器」把它编成 DICOM → samples/synthetic_ct.dcm
node tools/make_sample.mjs
```

第 2 步故意**不复制代码**，而是从 `cloudfilm-frame-export.user.js` 里抽出编码区块直接执行。原因：样本的价值在于「这就是脚本真实产出的东西」，另写一份实现迟早会与主实现分叉。副带好处是它同时充当编码器的冒烟测试。

验证样本：

```bash
python -c "
import pydicom, numpy as np
ds = pydicom.dcmread('samples/synthetic_ct.dcm')     # 不用 force，严格读取
raw = np.fromfile('samples/synthetic_ct.raw', dtype='<u2').reshape(ds.Rows, ds.Columns)
print('传输语法 :', ds.file_meta.TransferSyntaxUID.name)
print('像素一致 :', np.array_equal(ds.pixel_array, raw))
print('HU 范围  :', ds.pixel_array.min()-1024, '..', ds.pixel_array.max()-1024)
"
```

改脚本后建议至少跑一遍：

```bash
node --check cloudfilm-frame-export.user.js   # 语法
node tools/make_sample.mjs                    # 编码器仍可用
```

## License

[MIT](LICENSE)
