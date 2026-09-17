// ==UserScript==
// @name         云胶片逐帧导出（原始影像 / DICOM）
// @name:en      Cloud Film Frame Export
// @namespace    https://github.com/<YOUR-GITHUB-USERNAME>/cloudfilm-frame-export
// @version      2.0.1
// @description  在云阅片器里逐帧导出本人检查的未压缩原始影像，并在浏览器内直接拼装成标准 DICOM 文件（.dcm），无需任何后续转换软件
// @description:en  Export uncompressed frames from a cloud PACS viewer and rebuild standards-compliant DICOM files in the browser.
// @author       <YOUR NAME OR HANDLE>
// @license      MIT
// @homepageURL  https://github.com/<YOUR-GITHUB-USERNAME>/cloudfilm-frame-export
// @supportURL   https://github.com/<YOUR-GITHUB-USERNAME>/cloudfilm-frame-export/issues
// @match        https://*.medicalimagecloud.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 可选：开启自动更新
 *   Tampermonkey 只解析 ==UserScript== 块内部的元数据，所以下面两行要手动粘进上面的块里
 *   （放在 @grant 之后即可），并把 <YOUR-GITHUB-USERNAME> 换成你的用户名：
 *
 *     // @downloadURL  https://raw.githubusercontent.com/<YOUR-GITHUB-USERNAME>/cloudfilm-frame-export/main/cloudfilm-frame-export.user.js
 *     // @updateURL    https://raw.githubusercontent.com/<YOUR-GITHUB-USERNAME>/cloudfilm-frame-export/main/cloudfilm-frame-export.user.js
 *
 *   不填也不影响使用，只是需要自己回来下载新版本。
 */

/*
 * 这是什么
 *   把云端阅片器里「打不开、下不下来」的检查影像取回本地，并直接产出标准 DICOM 文件。
 *   全程在本机浏览器内完成，不经过任何第三方服务器。
 *
 * 适用场景
 *   部分云胶片平台的阅片器没有可用的导出功能：
 *     - 自带的「下载」按钮被隐藏（URL 里的 hidebtns 参数）
 *     - 整份打包接口点击后报「获取数据失败」（后端 storageNode 为空，服务未配置）
 *   本脚本改用阅片器自身读取影像的那条通道，逐帧取回完整像素数据。
 *
 * 使用范围
 *   仅用于导出**你自己，或已获得明确授权的人**的检查影像。
 *   影像属于个人敏感信息，请勿传播他人影像。详见仓库 README 的免责声明。
 *
 * 拿到的是什么
 *   服务端已切换为「逐帧未压缩原始像素」（compressionFormat = 1）：
 *   响应体就是裸的 16 位灰度像素，长度 = rows × columns × 2，不经过任何有损压缩。
 *   头部 X-ImageFrame 同时带回该帧的几何与灰度元数据，因此可在浏览器端
 *   直接拼装成标准 DICOM Part 10 文件，无需任何后续转换软件。
 *
 * 两个必须知道的点
 *   1) 地址末段的分辨率档必须用 0。实测 1/2/3 档会依次降到 1/4、1/16、1/64，
 *      而 X-ImageFrame 里的 rows/columns 始终是原始尺寸 —— 不校验长度就会错位。
 *      本脚本用「实际字节数 === rows × columns × 2」做强制校验，不匹配就重试并记录。
 *   2) 帧响应不可压缩、体积固定，整份导出体积远大于压缩格式，请预留磁盘空间。
 *
 * 使用
 *   1. 打开阅片器页面，右上角出现面板
 *   2. 先点「自检」，确认取帧正常
 *   3. 点「选取目录并导出」，选择一个空文件夹，等完成
 *   4. 导出期间不要刷新或关闭页面
 */

(function () {
  'use strict';

  var PANEL_ID = 'cfxe-panel';
  var STOP_FLAG = false;
  var RUNNING = false;
  var SESSION_LOST = false;

  var MAX_TRIES = 3;              // 单帧失败重试次数
  var LEVEL = 0;                  // 分辨率档：0 = 全分辨率（实测 1/2/3 = 1/4、1/16、1/64）
  var SOP_CT_IMAGE = '1.2.840.10008.5.1.4.1.1.2';
  var SOP_SECONDARY = '1.2.840.10008.5.1.4.1.1.7';
  var TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
  var CHARSET = 'ISO_IR 192';     // UTF-8，用于中文患者名
  var IMPL_UID = '2.25.329800735698586629295641978511506172918';

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function newUID() {
    if (window.crypto && window.crypto.randomUUID) {
      try { return '2.25.' + BigInt('0x' + crypto.randomUUID().replace(/-/g, '')).toString(); }
      catch (e) { /* 落到下面的兜底 */ }
    }
    var n = '';
    for (var i = 0; i < 30; i++) n += Math.floor(Math.random() * 10);
    return '2.25.1' + n;
  }

  /* ---------------- 页面数据读取 ---------------- */

  function getContext() {
    var $ = window.jQuery;
    if (!$) return { error: '页面依赖库未就绪，请稍后重试' };

    var canvas = document.querySelector('.displayCanvas');
    if (!canvas) return { error: '未找到影像画布，请确认已打开阅片器并加载出图像' };

    var ds = $(canvas).data('displaySet');
    var rawImg = $(canvas).data('rawImage');
    if (!ds || !rawImg || typeof rawImg.image !== 'function') {
      return { error: '影像信息尚未加载完成，请等待图像显示后再试' };
    }

    var cur = rawImg.image();
    var info = ds.studyInfo || {};
    var sets = (info.displaySets && info.displaySets.length) ? info.displaySets : [ds];

    return {
      studyId: cur.studyId,                                  // 帧接口用的内部 studyId
      cacheKey: window.LOAD_IMAGE_CACHE_KEY || '',
      sets: sets,
      studyInstanceUID: info.studyId || '',                   // 真实 StudyInstanceUID
      patientName: info.patientName || '',
      patientID: info.patientId || '',
      patientSex: info.gender || '',
      accessionNumber: info.accessionNumber || '',
      studyDate: info.studyDate || '',
      studyTime: info.studyTime || '',
      studyDescription: info.studyDescription || '',
      modality: info.modality || 'CT',
      description: info.studyDescription || '',
      patient: info.patientName || ''
    };
  }

  // 档位固定用 0（全分辨率）。路径形式已实测：
  //   /imageservice/api/image/dicom/{studyId}/{imageId}/{frame}/{level}?ck={cacheKey}
  function frameUrl(ctx, imageId, frame) {
    var base = '/imageservice/api/image/dicom/' +
      encodeURIComponent(ctx.studyId) + '/' +
      encodeURIComponent(imageId) + '/' +
      frame + '/' + LEVEL;
    return ctx.cacheKey ? base + '?ck=' + encodeURIComponent(ctx.cacheKey) : base;
  }

  function safeName(text, fallback) {
    var cleaned = String(text || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || fallback;
  }

  function pad(num, width) {
    var s = String(num);
    while (s.length < (width || 4)) s = '0' + s;
    return s;
  }

  /* ---------------- DICOM 编码（Part 10 / Explicit VR Little Endian） ---------------- */

  var LONG_VR = { OB: 1, OW: 1, OF: 1, SQ: 1, UT: 1, UN: 1 };

  function joinBytes(chunks) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  function elem(group, element, vr, data) {
    var isLong = !!LONG_VR[vr];
    var head = new Uint8Array(isLong ? 12 : 8);
    var dv = new DataView(head.buffer);
    dv.setUint16(0, group, true);
    dv.setUint16(2, element, true);
    head[4] = vr.charCodeAt(0);
    head[5] = vr.charCodeAt(1);
    if (isLong) dv.setUint32(8, data.length, true);
    else dv.setUint16(6, data.length, true);
    var out = new Uint8Array(head.length + data.length);
    out.set(head, 0);
    out.set(data, head.length);
    return out;
  }

  var ENC = new TextEncoder();

  function txt(s, padByte) {
    var b = ENC.encode(String(s));
    if (b.length % 2 === 0) return b;
    var o = new Uint8Array(b.length + 1);
    o.set(b);
    o[b.length] = padByte;
    return o;
  }

  var SP = 0x20, NUL = 0x00;   // 空格填充（文本类）/ NULL 填充（UI）

  function eUI(g, e, v) { return elem(g, e, 'UI', txt(v, NUL)); }
  function eCS(g, e, v) { return elem(g, e, 'CS', txt(v, SP)); }
  function eSH(g, e, v) { return elem(g, e, 'SH', txt(v, SP)); }
  function eLO(g, e, v) { return elem(g, e, 'LO', txt(v, SP)); }
  function ePN(g, e, v) { return elem(g, e, 'PN', txt(v, SP)); }
  function eDA(g, e, v) { return elem(g, e, 'DA', txt(v, SP)); }
  function eTM(g, e, v) { return elem(g, e, 'TM', txt(v, SP)); }
  function eIS(g, e, v) { return elem(g, e, 'IS', txt(String(v), SP)); }
  function eDS(g, e, v) { return elem(g, e, 'DS', txt(v, SP)); }
  function eUS(g, e, v) {
    var d = new Uint8Array(2);
    new DataView(d.buffer).setUint16(0, v & 0xffff, true);
    return elem(g, e, 'US', d);
  }
  function eUL(g, e, v) {
    var d = new Uint8Array(4);
    new DataView(d.buffer).setUint32(0, v >>> 0, true);
    return elem(g, e, 'UL', d);
  }

  // DS 值格式化：去掉多余尾零、避免科学计数法、长度不超 16
  function dsNum(v, dec) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    var s = (dec === undefined || dec === null) ? String(n) : n.toFixed(dec);
    if (s.indexOf('e') >= 0 || s.indexOf('E') >= 0) s = n.toFixed(dec || 8);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0' || s === '') s = '0';
    if (s.length > 16) s = String(Number(n).toPrecision(12)).replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // 取三元组（页面给的是类数组），不合法则退回默认值；dflt 传 null 表示「拿不到就返回 null」
  function vec3(v, dflt) {
    if (v && typeof v.length === 'number' && v.length >= 3) {
      var a = [Number(v[0]), Number(v[1]), Number(v[2])];
      if (isFinite(a[0]) && isFinite(a[1]) && isFinite(a[2])) return a;
    }
    return dflt ? dflt.slice() : null;
  }

  /**
   * 从序列内相邻帧的位置差推算层间距（中位数，规避多期相造成的重复位置）。
   * 写入 DICOM 的 SpacingBetweenSlices —— 3D 重建靠它，缺了会把层厚比例算错。
   */
  function seriesSpacing(set) {
    var imgs = (set && set.images) || [];
    if (imgs.length < 2) return 0;
    var gaps = [];
    var n = Math.min(imgs.length, 40);
    for (var i = 1; i < n; i++) {
      var a = vec3(imgs[i - 1].imagePosition, null);
      var b = vec3(imgs[i].imagePosition, null);
      if (!a || !b) continue;
      var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > 0.001) gaps.push(d);
    }
    if (!gaps.length) return 0;
    gaps.sort(function (p, q) { return p - q; });
    return gaps[Math.floor(gaps.length / 2)];
  }

  function planName(n) {
    var t = 0.99;
    if (Math.abs(n[2]) > t) return 'AXIAL';
    if (Math.abs(n[1]) > t) return 'CORONAL';
    if (Math.abs(n[0]) > t) return 'SAGITTAL';
    return 'OBLIQUE';
  }

  /**
   * 把一帧的原始像素 + 元数据拼成标准 DICOM 文件。
   * @param {Object} o 见下方调用处
   * @returns {Uint8Array}
   */
  function buildDicom(o) {
    var plan = planName(o.normal);

    var items = [];
    items.push(eCS(0x0008, 0x0005, CHARSET));
    items.push(eCS(0x0008, 0x0008, 'DERIVED\\SECONDARY\\' + plan));
    items.push(eUI(0x0008, 0x0016, o.sopClassUID));
    items.push(eUI(0x0008, 0x0018, o.sopInstanceUID));
    if (o.studyDate) items.push(eDA(0x0008, 0x0020, o.studyDate));
    if (o.studyDate) items.push(eDA(0x0008, 0x0021, o.studyDate));
    if (o.studyDate) items.push(eDA(0x0008, 0x0023, o.studyDate));
    if (o.studyTime) items.push(eTM(0x0008, 0x0030, o.studyTime));
    if (o.studyTime) items.push(eTM(0x0008, 0x0031, o.studyTime));
    if (o.studyTime) items.push(eTM(0x0008, 0x0033, o.studyTime));
    if (o.accessionNumber) items.push(eSH(0x0008, 0x0050, o.accessionNumber));
    items.push(eCS(0x0008, 0x0060, o.modality));
    items.push(eLO(0x0008, 0x0070, '云胶片逐帧导出'));
    if (o.studyDescription) items.push(eLO(0x0008, 0x1030, o.studyDescription));
    if (o.seriesDescription) items.push(eLO(0x0008, 0x103E, o.seriesDescription));
    items.push(ePN(0x0010, 0x0010, o.patientName || 'ANONYMOUS'));
    if (o.patientID) items.push(eLO(0x0010, 0x0020, o.patientID));
    if (o.patientSex) items.push(eCS(0x0010, 0x0040, o.patientSex));
    if (o.sliceThickness > 0) items.push(eDS(0x0018, 0x0050, dsNum(o.sliceThickness, 6)));
    if (o.spacingBetweenSlices > 0) items.push(eDS(0x0018, 0x0088, dsNum(o.spacingBetweenSlices, 6)));
    items.push(eUI(0x0020, 0x000D, o.studyInstanceUID));
    items.push(eUI(0x0020, 0x000E, o.seriesInstanceUID));
    items.push(eIS(0x0020, 0x0011, o.seriesNumber));
    items.push(eIS(0x0020, 0x0013, o.instanceNumber));
    items.push(eDS(0x0020, 0x0032, o.imagePosition.map(function (v) { return dsNum(v, 6); }).join('\\')));
    items.push(eDS(0x0020, 0x0037, o.imageOrientation.map(function (v) { return dsNum(v, 6); }).join('\\')));
    items.push(eUI(0x0020, 0x0052, o.frameOfReferenceUID));
    items.push(eDS(0x0020, 0x1041, dsNum(o.sliceLocation, 6)));
    items.push(eUS(0x0028, 0x0002, o.samplesPerPixel));
    items.push(eCS(0x0028, 0x0004, o.photometric));
    items.push(eUS(0x0028, 0x0010, o.rows));
    items.push(eUS(0x0028, 0x0011, o.columns));
    // 像素间距（量尺寸、做 3D 重建都靠它；缺了 DICOM 软件会拒绝对图像做测量）
    if (o.rowPixelSpacing > 0 && o.columnPixelSpacing > 0) {
      items.push(eDS(0x0028, 0x0030, dsNum(o.rowPixelSpacing, 6) + '\\' +
        dsNum(o.columnPixelSpacing, 6)));
    }
    items.push(eUS(0x0028, 0x0100, o.bitsAllocated));
    items.push(eUS(0x0028, 0x0101, o.bitsStored));
    items.push(eUS(0x0028, 0x0102, o.bitsStored - 1));
    items.push(eUS(0x0028, 0x0103, o.signed ? 1 : 0));
    items.push(eDS(0x0028, 0x1050, dsNum(o.windowCenter, 6)));
    items.push(eDS(0x0028, 0x1051, dsNum(o.windowWidth, 6)));
    items.push(eDS(0x0028, 0x1052, dsNum(o.rescaleIntercept, 6)));
    items.push(eDS(0x0028, 0x1053, dsNum(o.rescaleSlope, 6)));
    items.push(eLO(0x0028, 0x1054, 'HU'));
    items.push(elem(0x7FE0, 0x0010, 'OW', o.pixelData));   // PixelData 放最后

    var dataset = joinBytes(items);

    var metaItems = [];
    metaItems.push(elem(0x0002, 0x0001, 'OB', new Uint8Array([0x00, 0x01])));
    metaItems.push(eUI(0x0002, 0x0002, o.sopClassUID));
    metaItems.push(eUI(0x0002, 0x0003, o.sopInstanceUID));
    metaItems.push(eUI(0x0002, 0x0010, TS_EXPLICIT_LE));
    metaItems.push(eUI(0x0002, 0x0012, IMPL_UID));
    metaItems.push(eSH(0x0002, 0x0013, 'CLOUDFILM_EXPORT'));
    var meta = joinBytes(metaItems);

    var preamble = new Uint8Array(128);                                     // 128 字节全 0
    var magic = new Uint8Array([0x44, 0x49, 0x43, 0x4D]);                   // "DICM"
    var groupLen = eUL(0x0002, 0x0000, meta.length);

    return joinBytes([preamble, magic, groupLen, meta, dataset]);
  }

  /* ---------------- 取帧 ---------------- */

  /**
   * 取一帧并校验。返回 { bytes, header, u16 }。
   * 校验不通过会抛错（由调用方重试），避免写出损坏文件。
   */
  async function fetchFrame(ctx, imageId, frame) {
    var resp = await fetch(frameUrl(ctx, imageId, frame), { credentials: 'include' });

    if (resp.status === 401 || resp.status === 403) {
      var e = new Error('登录会话已失效（HTTP ' + resp.status + '）');
      e.sessionLost = true;
      throw e;
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    var hdrText = resp.headers.get('x-imageframe') || '';
    if (!hdrText) throw new Error('响应缺少 X-ImageFrame 头');

    var hdr;
    try { hdr = JSON.parse(hdrText); }
    catch (e2) { throw new Error('X-ImageFrame 解析失败'); }

    if (Number(hdr.compressionFormat) !== 1) {
      throw new Error('服务端返回的不是未压缩像素（compressionFormat=' +
        hdr.compressionFormat + '），格式可能已被切回压缩，请改用旧版脚本');
    }

    var buf = await resp.arrayBuffer();
    var expected = Number(hdr.rows) * Number(hdr.columns) * 2;

    if (buf.byteLength !== expected) {
      throw new Error('像素长度异常：收到 ' + buf.byteLength + ' 字节，应为 ' + expected +
        '（' + hdr.rows + '×' + hdr.columns + '×2，档位 ' + LEVEL + '），疑似降采样档位或传输截断');
    }

    return { bytes: buf, header: hdr, u16: new Uint16Array(buf) };
  }

  /* ---------------- 导出作业 ---------------- */

  function collectJobs(ctx, selectedIndexes) {
    var jobs = [];
    ctx.sets.forEach(function (set, setIndex) {
      if (selectedIndexes && selectedIndexes.indexOf(setIndex) === -1) return;
      var images = set.images || [];
      var desc = safeName((set.description || '').trim(), 'series');
      var sn = safeName(set.seriesNumber || '', String(setIndex + 1));
      var folder = pad(setIndex + 1, 2) + '_' + desc + '_SN' + sn;
      if (folder.length > 60) folder = folder.slice(0, 60);

      var n = 0;   // 序列内从 0001 开始编号，便于人工核对帧序
      var spacing = seriesSpacing(set);
      images.forEach(function (img) {
        var nf = Math.max(1, parseInt(img.nFrames || '1', 10) || 1);
        var pageFrame = parseInt(img.frame || '0', 10) || 0;
        for (var f = 0; f < nf; f++) {
          n++;
          jobs.push({
            folder: folder,
            base: pad(n, 4),
            imageId: img.imageId,
            frame: nf === 1 ? pageFrame : f,
            setIndex: setIndex,
            set: set,
            img: img,
            seq: n,
            spacing: spacing
          });
        }
      });
    });
    return jobs;
  }

  var dirCache = {};

  async function getDir(root, folder, create) {
    if (!create) {
      if (dirCache[folder]) return dirCache[folder];
      var d0 = await root.getDirectoryHandle(folder);
      dirCache[folder] = d0;
      return d0;
    }
    if (!dirCache[folder]) dirCache[folder] = await root.getDirectoryHandle(folder, { create: true });
    return dirCache[folder];
  }

  async function writeBytes(root, folder, fileName, bytes) {
    var dir = await getDir(root, folder, true);
    var handle = await dir.getFileHandle(fileName, { create: true });
    var w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
  }

  async function writeText(root, folder, fileName, text, mime) {
    var dir = await getDir(root, folder, true);
    var handle = await dir.getFileHandle(fileName, { create: true });
    var w = await handle.createWritable();
    await w.write(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
    await w.close();
  }

  async function fileExists(root, folder, fileName) {
    try {
      var dir = await getDir(root, folder, false);
      await dir.getFileHandle(fileName);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 把一帧的响应组装成写盘产物。
   * 返回 { files: [{name, bytes|text}], meta }
   */
  function buildOutputs(ctx, job, hdr, bytes, fmt) {
    var rows = Number(hdr.rows);
    var columns = Number(hdr.columns);

    // 几何数据：页面上的数值精度更高，优先用页面值；缺失时退回服务端头
    var img = job.img || {};
    var pos = vec3(img.imagePosition, (hdr.imagePosition || [0, 0, 0]).map(Number));
    var rowCos = vec3(img.rowCosines, (hdr.rowCosines || [1, 0, 0]).map(Number));
    var colCos = vec3(img.columnCosines, (hdr.columnCosines || [0, 1, 0]).map(Number));

    var normal = cross(rowCos, colCos);
    var normalLen = Math.sqrt(dot(normal, normal));
    // SliceLocation 用「图像位置在层面法向上的投影」——这样它与 ImagePositionPatient
    // 天然自洽（3D 重建软件会交叉核对这两项），服务端给的值仅作兜底。
    var sliceLocation;
    if (normalLen > 1e-6) {
      sliceLocation = dot(pos, normal) / normalLen;
    } else if (hdr.sliceLocation !== null && hdr.sliceLocation !== undefined) {
      sliceLocation = Number(hdr.sliceLocation);
    } else {
      sliceLocation = pos[2];
    }

    var seriesUID = job.set.id || newUID();
    var sopUID = job.imageId;
    var instanceNumber = parseInt(img.instanceNumber || '') || job.seq;

    var common = {
      sopClassUID: String(hdr.modality || 'CT').toUpperCase() === 'CT' ? SOP_CT_IMAGE : SOP_SECONDARY,
      sopInstanceUID: sopUID,
      studyInstanceUID: ctx.studyInstanceUID || ctx.studyId,
      seriesInstanceUID: seriesUID,
      seriesNumber: job.set.seriesNumber || String(job.setIndex + 1),
      seriesDescription: (job.set.description || '').trim(),
      studyDescription: ctx.studyDescription,
      patientName: ctx.patientName,
      patientID: ctx.patientID,
      patientSex: ctx.patientSex,
      accessionNumber: ctx.accessionNumber,
      studyDate: ctx.studyDate,
      studyTime: ctx.studyTime,
      modality: String(hdr.modality || 'CT').toUpperCase(),
      instanceNumber: instanceNumber,
      imagePosition: pos,
      imageOrientation: rowCos.concat(colCos),
      normal: normal,
      sliceLocation: sliceLocation,
      sliceThickness: Number(hdr.sliceThickness) || 0,
      spacingBetweenSlices: job.spacing || 0,
      frameOfReferenceUID: hdr.frameOfReferenceUID || ctx.studyInstanceUID || ctx.studyId,
      rows: rows,
      columns: columns,
      // 像素间距：DICOM 的 PixelSpacing = [行间距, 列间距]（单位 mm）
      rowPixelSpacing: Number(hdr.rowPixelSpacing) || 0,
      columnPixelSpacing: Number(hdr.columnPixelSpacing) || 0,
      bitsAllocated: Number(hdr.bitsAllocated) || 16,
      bitsStored: Number(hdr.bitsStored) || 16,
      signed: !!hdr.signed,
      samplesPerPixel: Number(hdr.samplesPerPixel) || 1,
      photometric: hdr.photometricInterpretation || 'MONOCHROME2',
      rescaleIntercept: Number(hdr.intercept) || 0,
      rescaleSlope: Number(hdr.slope) || 1,
      windowCenter: Number(hdr.windowCenter) || 0,
      windowWidth: Number(hdr.windowWidth) || 1,
      pixelData: new Uint8Array(bytes)
    };

    var files = [];

    if (fmt === 'dcm' || fmt === 'both') {
      files.push({ name: job.base + '.dcm', bytes: buildDicom(common) });
    }
    if (fmt === 'raw' || fmt === 'both') {
      files.push({ name: job.base + '.raw', bytes: new Uint8Array(bytes) });
    }
    if (fmt === 'raw') {
      files.push({
        name: job.base + '.json',
        text: JSON.stringify({
          tool: '云胶片逐帧导出 v2.0.1',
          imageId: job.imageId,
          frame: job.frame,
          seriesInstanceUID: seriesUID,
          studyInstanceUID: ctx.studyInstanceUID || ctx.studyId,
          instanceNumber: instanceNumber,
          imagePosition: pos,
          rowCosines: rowCos,
          columnCosines: colCos,
          rows: rows,
          columns: columns,
          pixelBytes: bytes.byteLength,
          serverHeader: hdr
        }, null, 1)
      });
    }

    // 供 _帧元数据.json 使用的精简记录
    var meta = {
      file: job.base + '.dcm',
      imageId: job.imageId,
      frame: job.frame,
      instanceNumber: instanceNumber,
      imagePosition: pos,
      sliceLocation: +sliceLocation.toFixed(6),
      pixelBytes: bytes.byteLength,
      windowCenter: common.windowCenter,
      windowWidth: common.windowWidth,
      serverHeader: hdr
    };

    return { files: files, meta: meta };
  }

  /* ---------------- 面板 ---------------- */

  var ui = {};

  function setStatus(text) { if (ui.status) ui.status.textContent = text; }

  function setProgress(done, total, bytes) {
    if (ui.bar) ui.bar.style.width = (total ? (done / total * 100) : 0).toFixed(1) + '%';
    if (ui.count) {
      ui.count.textContent = done + ' / ' + total +
        (bytes ? '　' + (bytes / 1048576).toFixed(0) + ' MB' : '');
    }
  }

  /* ---------------- 自检 ---------------- */

  async function selfTest() {
    if (RUNNING) return;
    var ctx = getContext();
    if (ctx.error) { setStatus(ctx.error); return; }

    var jobs = collectJobs(ctx, null);
    if (!jobs.length) { setStatus('没有可导出的帧'); return; }

    setStatus('自检中…');
    var job = jobs[0];
    try {
      var r = await fetchFrame(ctx, job.imageId, job.frame);
      var arr = r.u16;
      var mn = arr[0], mx = arr[0], i;
      for (i = 0; i < arr.length; i++) { if (arr[i] < mn) mn = arr[i]; if (arr[i] > mx) mx = arr[i]; }

      var out = buildOutputs(ctx, job, r.header, r.bytes, 'dcm');
      var dcm = out.files[0].bytes;
      var okMagic = dcm[128] === 0x44 && dcm[129] === 0x49 && dcm[130] === 0x43 && dcm[131] === 0x4D;

      var totalFrames = 0;
      ctx.sets.forEach(function (s) { totalFrames += (s.images || []).length; });
      var estGB = (totalFrames * r.bytes.byteLength / 1073741824);

      setStatus('自检通过 ✓　' + r.header.rows + '×' + r.header.columns + '　16 位　' +
        r.bytes.byteLength.toLocaleString() + ' 字节/帧　HU ' + (mn - 1024) + '…' + (mx - 1024) +
        '　DICOM ' + dcm.length.toLocaleString() + ' 字节' + (okMagic ? '（DICM 标识正确）' : '（DICM 标识异常！）') +
        '　全部 ' + totalFrames + ' 帧约 ' + estGB.toFixed(2) + ' GB　序列 ' + job.folder + '/' + job.base);
    } catch (e) {
      setStatus('自检失败：' + (e && e.message ? e.message : String(e)));
    }
  }

  /* ---------------- 导出 ---------------- */

  async function startExport() {
    if (RUNNING) return;

    var ctx = getContext();
    if (ctx.error) { setStatus(ctx.error); return; }

    if (!window.showDirectoryPicker) {
      setStatus('当前浏览器不支持目录写入，请使用 Edge / Chrome 桌面版');
      return;
    }

    var picks = Array.prototype.slice.call(ui.list.querySelectorAll('input[type=checkbox]'));
    var selected = picks
      .map(function (cb, i) { return cb.checked ? i : -1; })
      .filter(function (i) { return i >= 0; });
    if (!selected.length) { setStatus('请至少勾选一个序列'); return; }

    var skipExisting = ui.skip.checked;
    var saveMeta = ui.meta.checked;
    var fmt = ui.fmt.value;
    var concurrency = parseInt(ui.conc.value, 10) || 3;

    var root;
    try {
      root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'cfxe-dir' });
    } catch (e) {
      setStatus('已取消目录选择');
      return;
    }

    var jobs = collectJobs(ctx, selected);
    var total = jobs.length;
    if (!total) { setStatus('没有可导出的帧'); return; }

    RUNNING = true;
    STOP_FLAG = false;
    SESSION_LOST = false;
    dirCache = {};
    ui.go.disabled = true;
    ui.stop.disabled = false;
    ui.test.disabled = true;

    var cursor = 0;
    var done = 0;
    var bytes = 0;
    var skipped = 0;
    var failed = [];
    var t0 = Date.now();

    // 按序列汇总元数据
    var metaBySeries = {};
    selected.forEach(function (si) {
      var s = ctx.sets[si];
      metaBySeries[si] = {
        seriesIndex: si + 1,
        seriesInstanceUID: s.id || '',
        seriesNumber: s.seriesNumber || '',
        description: (s.description || '').trim(),
        framesInSeries: (s.images || []).length,
        frames: []
      };
    });

    async function worker() {
      while (!STOP_FLAG) {
        var idx = cursor++;
        if (idx >= total) return;
        var job = jobs[idx];
        var ok = false;
        var lastErr = '';

        for (var attempt = 1; attempt <= MAX_TRIES && !STOP_FLAG; attempt++) {
          try {
            var first = job.base + (fmt === 'raw' ? '.raw' : '.dcm');
            if (skipExisting && await fileExists(root, job.folder, first)) {
              skipped++;
              done++;
              setProgress(done, total, bytes);
              ok = true;
              break;
            }

            var r = await fetchFrame(ctx, job.imageId, job.frame);
            var out = buildOutputs(ctx, job, r.header, r.bytes, fmt);

            for (var fi = 0; fi < out.files.length; fi++) {
              var f = out.files[fi];
              if (f.bytes) await writeBytes(root, job.folder, f.name, f.bytes);
              else await writeText(root, job.folder, f.name, f.text, 'application/json');
            }

            bytes += r.bytes.byteLength;
            if (metaBySeries[job.setIndex]) {
              out.meta.seriesFolder = job.folder;
              metaBySeries[job.setIndex].frames.push(out.meta);
            }
            ok = true;
            break;

          } catch (err) {
            lastErr = (err && err.message ? err.message : String(err));
            if (err && err.sessionLost) {
              SESSION_LOST = true;
              STOP_FLAG = true;
              break;
            }
            if (attempt < MAX_TRIES) await delay(1200 * attempt);
          }
        }

        if (!ok) failed.push(job.folder + '/' + job.base + '（' + lastErr + '）');
        done++;
        setProgress(done, total, bytes);
        if (!STOP_FLAG) {
          var avg = (Date.now() - t0) / Math.max(done, 1);
          setStatus('导出中… 预计剩余 ' + Math.ceil((total - done) * avg / 1000 / 60) + ' 分钟');
        }
      }
    }

    var pool = [];
    for (var k = 0; k < Math.min(concurrency, total); k++) pool.push(worker());
    await Promise.all(pool);

    RUNNING = false;
    ui.go.disabled = false;
    ui.stop.disabled = true;
    ui.test.disabled = false;

    var mins = ((Date.now() - t0) / 60000).toFixed(1);

    // 帧元数据总表
    if (saveMeta) {
      try {
        var doc = {
          tool: '云胶片逐帧导出 v2.0.1',
          exportedAt: new Date().toISOString(),
          source: { title: document.title, url: location.href },
          study: {
            studyInstanceUID: ctx.studyInstanceUID,
            patientName: ctx.patientName,
            patientID: ctx.patientID,
            patientSex: ctx.patientSex,
            accessionNumber: ctx.accessionNumber,
            studyDate: ctx.studyDate,
            studyTime: ctx.studyTime,
            studyDescription: ctx.studyDescription,
            modality: ctx.modality
          },
          note: 'HU = 像素值 + RescaleIntercept（本检查为 -1024）。' +
                'serverHeader 为服务端 X-ImageFrame 原始内容，含像素间距、层厚等几何参数。',
          series: Object.keys(metaBySeries).map(function (k2) { return metaBySeries[k2]; })
        };
        await writeText(root, '', '_帧元数据.json', JSON.stringify(doc, null, 1), 'application/json');
      } catch (e) { /* 不影响主流程 */ }
    }

    if (failed.length) {
      try {
        var report = ['导出失败 ' + failed.length + ' 帧（每帧已自动重试 ' + MAX_TRIES + ' 次）：', '']
          .concat(failed).join('\r\n');
        await writeText(root, '', '_导出失败清单.txt', report);
      } catch (e) { /* 不影响主流程 */ }
    }

    setStatus((SESSION_LOST ? '登录会话已失效，导出中止。请刷新页面重新登录后再续传（勾选「跳过已存在」即可）。'
      : (STOP_FLAG ? '已停止。' : '导出完成。')) +
      ' 共 ' + done + ' 帧，本次写入 ' + (bytes / 1048576).toFixed(0) + ' MB，用时 ' + mins + ' 分钟' +
      (skipped ? '（其中 ' + skipped + ' 帧原本已存在被跳过，未计入体积）' : '') +
      (failed.length ? '；' + failed.length + ' 帧未取到，清单见 _导出失败清单.txt' : ''));
  }

  /* ---------------- 界面 ---------------- */

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    var box = document.createElement('div');
    box.id = PANEL_ID;
    box.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483646',
      'width:302px', 'background:#fff', 'color:#1a1d21',
      'border:1px solid #d8dde4', 'border-radius:10px',
      'box-shadow:0 8px 28px rgba(15,23,42,.18)',
      'font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'overflow:hidden'
    ].join(';');

    var selStyle = 'width:100%;padding:4px 6px;border:1px solid #d8dde4;border-radius:5px;font-size:12.5px;background:#fff';

    box.innerHTML = [
      '<div id="cfxe-head" style="display:flex;align-items:center;justify-content:space-between;',
      'padding:10px 12px;background:#f6f8fa;border-bottom:1px solid #e5e9ef;cursor:move;user-select:none">',
      '<b style="font-size:13px">逐帧导出原始影像</b>',
      '<span id="cfxe-fold" style="cursor:pointer;color:#6b7280;font-size:16px;line-height:1">−</span>',
      '</div>',

      '<div id="cfxe-body" style="padding:12px">',

      '<div id="cfxe-list" style="max-height:180px;overflow:auto;border:1px solid #e5e9ef;',
      'border-radius:6px;padding:6px 8px;margin-bottom:10px;background:#fbfcfd">',
      '<span style="color:#6b7280">正在读取序列…</span>',
      '</div>',

      '<div style="margin-bottom:8px">',
      '<div style="color:#6b7280;font-size:11.5px;margin-bottom:3px">导出格式</div>',
      '<select id="cfxe-fmt" style="' + selStyle + '">',
      '<option value="dcm">标准 DICOM 文件（.dcm，可直接打开）</option>',
      '<option value="raw">原始像素（.raw + .json）</option>',
      '<option value="both">两种都要</option>',
      '</select>',
      '</div>',

      '<label style="display:flex;align-items:center;gap:6px;margin-bottom:5px">',
      '<input id="cfxe-skip" type="checkbox" checked> 跳过已存在的文件（可断点续传）</label>',
      '<label style="display:flex;align-items:center;gap:6px;margin-bottom:8px">',
      '<input id="cfxe-meta" type="checkbox" checked> 保存 _帧元数据.json（便于核对/后处理）</label>',

      '<label style="display:flex;align-items:center;gap:6px;margin-bottom:10px">并发数 ',
      '<input id="cfxe-conc" type="number" min="1" max="8" value="3" ',
      'style="width:52px;padding:2px 6px;border:1px solid #d8dde4;border-radius:4px">',
      '<span style="color:#6b7280;font-size:11.5px">（1-8）</span></label>',

      '<div style="display:flex;gap:8px;margin-bottom:10px">',
      '<button id="cfxe-go" style="flex:1;padding:8px 10px;border:0;border-radius:6px;',
      'background:#1668dc;color:#fff;font-size:13px;cursor:pointer">选取目录并导出</button>',
      '<button id="cfxe-stop" disabled style="padding:8px 12px;border:1px solid #d8dde4;',
      'border-radius:6px;background:#fff;color:#1a1d21;font-size:13px;cursor:pointer">停止</button>',
      '</div>',

      '<div style="height:6px;background:#eef1f5;border-radius:3px;overflow:hidden;margin-bottom:6px">',
      '<div id="cfxe-bar" style="height:100%;width:0;background:#1668dc;transition:width .2s"></div>',
      '</div>',

      '<div id="cfxe-count" style="color:#6b7280;font-size:12px">0 / 0</div>',
      '<div id="cfxe-status" style="margin-top:6px;font-size:11.8px;color:#374151;word-break:break-all"></div>',

      '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #eef1f5;display:flex;',
      'align-items:center;justify-content:space-between">',
      '<button id="cfxe-test" style="padding:4px 10px;border:1px solid #d8dde4;border-radius:5px;',
      'background:#fff;color:#1a1d21;font-size:12px;cursor:pointer">自检（取 1 帧）</button>',
      '<span style="color:#6b7280;font-size:11px">未压缩 16 位 · 全分辨率</span>',
      '</div>',

      '</div>'
    ].join('');

    document.body.appendChild(box);

    ui.list = box.querySelector('#cfxe-list');
    ui.skip = box.querySelector('#cfxe-skip');
    ui.meta = box.querySelector('#cfxe-meta');
    ui.conc = box.querySelector('#cfxe-conc');
    ui.fmt = box.querySelector('#cfxe-fmt');
    ui.go = box.querySelector('#cfxe-go');
    ui.stop = box.querySelector('#cfxe-stop');
    ui.test = box.querySelector('#cfxe-test');
    ui.bar = box.querySelector('#cfxe-bar');
    ui.count = box.querySelector('#cfxe-count');
    ui.status = box.querySelector('#cfxe-status');

    ui.go.addEventListener('click', startExport);
    ui.test.addEventListener('click', selfTest);
    ui.stop.addEventListener('click', function () {
      STOP_FLAG = true;
      setStatus('正在停止…');
    });

    var folded = false;
    box.querySelector('#cfxe-fold').addEventListener('click', function () {
      folded = !folded;
      box.querySelector('#cfxe-body').style.display = folded ? 'none' : '';
      this.textContent = folded ? '+' : '−';
    });

    // 可拖动
    (function () {
      var head = box.querySelector('#cfxe-head');
      var dragging = false, ox = 0, oy = 0;
      head.addEventListener('mousedown', function (e) {
        dragging = true;
        ox = e.clientX - box.offsetLeft;
        oy = e.clientY - box.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        box.style.left = (e.clientX - ox) + 'px';
        box.style.top = (e.clientY - oy) + 'px';
        box.style.right = 'auto';
      });
      document.addEventListener('mouseup', function () { dragging = false; });
    })();

    fillSeriesList();
  }

  function fillSeriesList() {
    var ctx = getContext();
    if (ctx.error) {
      ui.list.innerHTML = '<span style="color:#b45309">' + ctx.error + '</span>';
      return;
    }
    var html = ctx.sets.map(function (set, i) {
      var n = (set.images || []).length;
      var desc = (set.description || '').trim() || ('序列 ' + (i + 1));
      return '<label style="display:flex;align-items:center;gap:7px;padding:3px 0;cursor:pointer">' +
        '<input type="checkbox" checked data-set="' + i + '">' +
        '<span style="flex:1">' + desc + '</span>' +
        '<span style="color:#6b7280;font-size:11.5px">' + n + ' 帧</span></label>';
    }).join('');
    var total = ctx.sets.reduce(function (s, set) { return s + (set.images || []).length; }, 0);
    ui.list.innerHTML = html +
      '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #eef1f5;' +
      'color:#6b7280;font-size:11.5px">合计 ' + total + ' 帧</div>';
  }

  /* ---------------- 启动 ---------------- */

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var ready = document.querySelector('.displayCanvas') && window.jQuery;
    if (ready) {
      clearInterval(timer);
      buildPanel();
      setTimeout(fillSeriesList, 1500);
    } else if (tries > 60) {
      clearInterval(timer);
      buildPanel();
    }
  }, 1000);
})();
