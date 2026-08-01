'use strict';
// ============================================================
// 形状层:全部公式来自 iOS 26.3 QuartzCore default.metallib 反汇编
// (reverse-engineering/quartzcore_sdf_pipeline_decompiled.md)
// SDF 流转格式 = vec4(distance, gradient.xy, valid),与苹果一致
// ============================================================
const FRAG = `#version 300 es
precision highp float;
uniform vec2  uRes;
uniform vec4  uBlob;   // cx, cy, halfX, halfY (px, y 向下)
uniform float uEdge;   // 顶部黑边高度
uniform float uK;      // 融合半径
uniform float uHeight, uRefract, uHlAmt, uAb, uDpr, uCont;
uniform float uDark;   // 液滴材质 1=贴边黑玻璃 0=落地浅磨砂
uniform float uValid;
uniform sampler2D uTex;
uniform float uHasTex;
uniform vec2  uTexSize;
out vec4 outColor;

// ---------- 背景:壁纸纹理 (cover-fit),无壁纸时纯黑 ----------
// blurR>0 时按苹果的 blur→mip 映射取 LOD: lod = log2(r<2 ? r/2+1 : r)
vec3 bgcol(vec2 p, float blurR){
  if (uHasTex > 0.5) {
    float s  = max(uRes.x / uTexSize.x, uRes.y / uTexSize.y);
    vec2  uv = (p - 0.5 * (uRes - uTexSize * s)) / (uTexSize * s);
    float lod = max(0.0, log2(blurR < 2.0 ? blurR * 0.5 + 1.0 : blurR));
    return textureLod(uTex, clamp(uv, vec2(0.002), vec2(0.998)), lod).rgb;
  }
  return vec3(0.0);   // 程序化背景:纯黑
}

// ---------- rounded-box SDF + 解析梯度 ----------
// supercircle_sdf 的圆角分支(cornerFlags=圆角);圆/胶囊/圆角矩形同一原语
vec4 sdRoundBox(vec2 p, vec2 c, vec2 b, float r){
  vec2 lp = p - c;
  vec2 q  = abs(lp) - b + r;
  vec2 mq = max(q, vec2(0.0));
  float dOut = length(mq);
  float d = dOut + min(max(q.x, q.y), 0.0) - r;
  vec2 grad = (dOut > 1e-4) ? (mq / dOut) * sign(lp)
            : ((q.x > q.y) ? vec2(sign(lp.x), 0.0) : vec2(0.0, sign(lp.y)));
  return vec4(d, grad, 1.0);
}

// ---------- 苹果 sdf_union:梯度感知 smooth min ----------
// QuartzCore ShaderUtils_::sdf_union 逐行翻译
vec4 sdfUnion(vec4 a, vec4 b, float k){
  if (b.w == 0.0) b = vec4(10000.0, 0.0, 0.0, 0.0);     // half 0x70E2
  float kEff = k * clamp(0.5 - 0.5 * dot(a.yz, b.yz), 0.0, 1.0) + 1e-4;
  float h = clamp(0.5 + 0.5 * (b.x - a.x) / kEff, 0.0, 1.0);
  float d = mix(b.x, a.x, h) - kEff * h * (1.0 - h);    // IQ 多项式 smin
  vec2  g = mix(b.yz, a.yz, h);                         // 梯度同步混合
  return vec4(d, normalize(g + vec2(1e-5)), 1.0);
}

void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);  // y 向下,对齐 UI 坐标

  vec4 bar  = vec4(p.y - uEdge, 0.0, 1.0, 1.0);            // 顶部黑边 = 半平面
  vec4 blob = sdRoundBox(p, uBlob.xy, uBlob.zw, min(uBlob.z, uBlob.w));
  blob.w = uValid;
  vec4 s = sdfUnion(bar, blob, uK);
  float d = s.x;  vec2 g = s.yz;

  // 背景 + 外侧软阴影 (sdf_shadow)
  float sh = (d > 0.0) ? exp(-d / 30.0) * 0.22 : 0.0;
  vec3 col = bgcol(p, 0.0) * (1.0 - sh);

  // ---------- 玻璃 = 折射 + 高光,无 face color ----------
  // 公式同 QuartzCore sdf_glass_displacement/highlight,参数取 z1han siri27 标定
  float wb = uValid * clamp(0.5 + 0.5 * (bar.x - blob.x) / 24.0, 0.0, 1.0);
  float darkAmt = mix(1.0, uDark, wb);

  // 梯度向"中心径向"微混 8%,透镜更圆润(只对液滴,bar 区域 wb≈0)
  vec2 lp = p - uBlob.xy;
  vec2 radial = normalize(vec2(lp.x, uBlob.z * lp.y / max(uBlob.w, 0.001)) + 1e-5);
  vec2 gr = normalize(mix(g, radial, 0.08 * wb));

  // 圆弧剖面 (curvature=1),折射量为负 → 边缘把外侧内容"拉进来"(放大镜感)
  float t   = clamp(-d / uHeight, 0.0, 1.0);
  float mag = 1.0 - sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 0.0));
  vec2  dsp = -uRefract * mag * gr;
  // 边缘环:近清晰采样 + 色差
  vec3 sharp;
  sharp.r = bgcol(p + dsp * (1.0 - uAb), 3.0).r;
  sharp.g = bgcol(p + dsp, 3.0).g;
  sharp.b = bgcol(p + dsp * (1.0 + uAb), 3.0).b;
  // 内部:8 抽样圆盘 + 中等 mip 联合模糊——纯 mip 三线性有块感,圆盘把它抹匀
  float br = mix(14.0, 60.0, clamp(-d / (50.0 * uDpr), 0.0, 1.0)) * uDpr;
  vec3 soft = bgcol(p + dsp, br * 0.4) * 0.2;
  for (int i = 0; i < 8; i++) {
    float a = 0.7854 * float(i);
    soft += bgcol(p + dsp + vec2(cos(a), sin(a)) * br * 0.7, br * 0.4) * 0.1;
  }
  float deep = clamp(-d / (40.0 * uDpr), 0.0, 1.0);   // 越深入越用模糊
  vec3 refr = mix(sharp, soft, deep);

  // face 压暗 = 乘法系数的垂直渐变(真机截图逐像素实测标定):
  // 顶 ×0.03(近纯黑) 中 ×0.19 底 ×0.34,线性 m ≈ 0.20 + 0.40·ny;
  // 用乘法不残留底图对比(不发花),用渐变还原"上黑下透"
  float ny = (p.y - uBlob.y) / max(uBlob.w, 1.0);   // -1=顶 +1=底
  float m  = clamp(0.20 + 0.40 * ny, 0.0, 1.0);
  float crush = mix(1.0, m, uCont * wb);
  refr = refr * crush + vec3(0.008, 0.010, 0.014) * uCont * wb;

  // edge_bleed(IR 解码):亮背景从边缘渗入玻璃内侧——圆剖面位移 + mip 模糊
  // + 贴边距离带 + 亮度四次方门控(背景越亮渗越多,暗处几乎不渗)
  float xb  = clamp(-d / (10.0 * uDpr), 0.0, 1.0);
  float dbl = 24.0 * uDpr * (1.0 - sqrt(xb * (2.0 - xb)));
  vec3 bleed = bgcol(p + gr * dbl, 22.0);
  float wbd  = clamp((d + 26.0 * uDpr) / (20.0 * uDpr), 0.0, 1.0);
  float blum = dot(bleed, vec3(0.2125, 0.7154, 0.0721));
  float bm   = pow(clamp(blum * 1.2, 0.0, 1.0), 2.0) * wbd;
  refr = mix(refr, bleed, bm * bm * 0.85);

  vec3 glass = mix(refr, refr * 0.10 + vec3(0.016), darkAmt); // 落地=纯玻璃,贴边=黑玻璃

  // 高光:细带 2.2px,key 45° + fill 225° 对角双光,锐掩码 cut 0.52,压缩 norm 8
  float qd  = -d;
  float hw  = 2.2 * uDpr;
  float aaq = max(fwidth(qd), 1e-3);
  float band = (1.0 - clamp(qd / hw, 0.0, 1.0))
             * clamp(qd / aaq + 0.5, 0.0, 1.0)
             * clamp((hw - qd) / aaq + 0.5, 0.0, 1.0);
  vec2 kdir = vec2(0.7071, 0.7071);
  float key  = band * clamp((dot(kdir, gr) - 0.52) / 0.48, 0.0, 1.0);
  float fill = band * clamp((dot(-kdir, gr) - 0.52) / 0.48, 0.0, 1.0);
  key  = key  / (1.0 + (1.0 - key)  * 8.0);
  fill = fill / (1.0 + (1.0 - fill) * 8.0);
  glass += (key + fill) * uHlAmt * mix(1.0, 0.4, darkAmt);

  float aaw = max(fwidth(d), 1e-3);
  col = mix(col, glass, smoothstep(aaw, -aaw, d));
  outColor = vec4(col, 1.0);
}`;

const VERT = `#version 300 es
void main(){ vec2 v = vec2((gl_VertexID<<1)&2, gl_VertexID&2);
  gl_Position = vec4(v*2.0-1.0, 0.0, 1.0); }`;

// ---------- WebGL 样板 ----------
const stage = document.getElementById('stage'), cv = document.getElementById('gl');
const gl = cv.getContext('webgl2', { antialias: false });
function sh(type, src){ const s = gl.createShader(type); gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
  return s; }
const prog = gl.createProgram();
gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog); gl.useProgram(prog);
const U = {}; ['uRes','uBlob','uEdge','uK','uHeight','uRefract','uHlAmt','uAb','uDpr','uDark',
  'uCont','uValid','uTex','uHasTex','uTexSize'].forEach(n => U[n] = gl.getUniformLocation(prog, n));
gl.uniform1i(U.uTex, 0);

// ---------- 壁纸:必应每日 / 用户上传 / 程序化,可在设置面板切换 ----------
let hasTex = 0, texSize = [1, 1];
{
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function apply(im){
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.generateMipmap(gl.TEXTURE_2D);
      hasTex = 1; texSize = [im.width, im.height];
    } catch (e) { /* 纹理跨域被拦 -> 程序化背景 */ }
  }

  function loadBing(){
    (async () => {
      try {
        const api = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN';
        const meta = await fetch(api).then(r => r.json());
        const rel = meta.images && meta.images[0] && meta.images[0].url;
        if (!rel) return;
        const full = rel.startsWith('http') ? rel : 'https://www.bing.com' + rel;
        const blob = await fetch(full).then(r => r.blob());
        const objUrl = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => { apply(im); URL.revokeObjectURL(objUrl); };
        im.src = objUrl;
      } catch (e) { /* 离线/被墙 -> 程序化背景 */ }
    })();
  }

  function loadWallpaper(){
    const mode = localStorage.getItem('nt_bg_mode') || 'bing';
    if (mode === 'custom') {
      const data = localStorage.getItem('nt_bg');
      if (data) { const im = new Image(); im.onload = () => apply(im); im.src = data; return; }
    }
    if (mode === 'bing' || mode === 'custom') loadBing();
    // procedural: 不加载, hasTex 保持 0 -> 程序化背景
  }
  loadWallpaper();

  // 面板:背景来源切换(自定义下拉) + 上传
  const bgUpload = document.getElementById('bgUpload');
  const bgUploadBtn = document.getElementById('bgUploadBtn');
  const bgHint = document.getElementById('bgHint');
  const bgModeWrap = document.getElementById('bgModeWrap');
  const bgModeBtn = document.getElementById('bgModeBtn');
  const bgModeLabel = document.getElementById('bgModeLabel');
  const bgModeDp = document.getElementById('bgModeDp');

  var BG_OPTS = { bing:'必应每日壁纸', custom:'自定义图片', procedural:'纯色程序化' };

  function syncBgUI(){
    var m = localStorage.getItem('nt_bg_mode') || 'bing';
    if (bgModeLabel) bgModeLabel.textContent = BG_OPTS[m] || BG_OPTS.bing;
    if (bgUploadBtn) bgUploadBtn.style.display = m === 'custom' ? 'block' : 'none';
    if (bgHint) bgHint.textContent = localStorage.getItem('nt_bg')
      ? '已上传: ' + (localStorage.getItem('nt_bg_name') || '自定义图片')
      : '';
    // 高亮当前选中项
    if (bgModeDp){
      Array.from(bgModeDp.children).forEach(function(o){ o.classList.toggle('active', o.dataset.val === m); });
    }
  }

  window.closeAllDrops = function(){
    document.querySelectorAll('.c-select.open').forEach(function(el){ el.classList.remove('open'); });
  };
  document.addEventListener('click', function(e){ if (!e.target.closest('.c-select')) window.closeAllDrops(); });

  if (bgModeBtn && bgModeDp){
    bgModeBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var wasOpen = bgModeWrap.classList.contains('open');
      window.closeAllDrops();
      if (!wasOpen) bgModeWrap.classList.add('open');
    });
    bgModeDp.addEventListener('click', function(e){
      var opt = e.target.closest('.c-opt'); if (!opt) return;
      var val = opt.dataset.val;
      localStorage.setItem('nt_bg_mode', val);
      hasTex = 0;
      syncBgUI();
      loadWallpaper();
      bgModeWrap.classList.remove('open');
    });
  }
  syncBgUI();

  // 按钮点击触发隐藏的 file input
  if (bgUploadBtn && bgUpload){
    bgUploadBtn.addEventListener('click', function(){ bgUpload.click(); });
  }

  if (bgUpload){
    bgUpload.addEventListener('change', () => {
      const file = bgUpload.files && bgUpload.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const im = new Image();
        im.onload = () => {
          const max = 1920; let w = im.width, h = im.height;
          if (w > max || h > max){ const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(im, 0, 0, w, h);
          const data = c.toDataURL('image/jpeg', 0.85);
          try { localStorage.setItem('nt_bg', data); localStorage.setItem('nt_bg_name', file.name); }
          catch (e) { alert('图片太大，本地存储放不下，换张小点的'); return; }
          localStorage.setItem('nt_bg_mode', 'custom');
          syncBgUI();
          syncBgUI();
          hasTex = 0;
          const fim = new Image(); fim.onload = () => apply(fim); fim.src = data;
        };
        im.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
}

const dpr = Math.min(devicePixelRatio || 1, 2);
function resize(){ cv.width = stage.clientWidth * dpr; cv.height = stage.clientHeight * dpr;
  gl.viewport(0, 0, cv.width, cv.height); }
addEventListener('resize', resize); resize();

// ============================================================
// 动画层:弹簧全在 CPU,shader 只收 uniform(和 render server 同构)
// ============================================================
class Spring {
  constructor(v){ this.x = v; this.v = 0; this.t = v; this.om = 11; this.ze = 0.72; }
  set(om, ze){ this.om = om; this.ze = ze; return this; }
  step(dt){
    this.v += (this.om * this.om * (this.t - this.x) - 2 * this.ze * this.om * this.v) * dt;
    this.x += this.v * dt; return this.x;
  }
}
const sp = { cx: new Spring(0), cy: new Spring(0), bx: new Spring(0), by: new Spring(0),
             k: new Spring(64), dark: new Spring(1), cont: new Spring(0) };

const P = { k: 64, height: 18, refract: 14, hl: 1.5, ab: 0.12, cont: 0.5, om: 11, ze: 0.72 };
const EDGE = 26;                       // 黑边高度 (css px)
const R = 34;                          // 拖拽液滴半径
let state = 'IDLE';                    // IDLE | DRAG | CAPSULE | RETRACT
let pointer = { x: 0, y: 0 };

function capsuleRect(){
  const sw = stage.clientWidth;
  // 手机:留固定 22px 边距,占满可用宽;桌面:62% 居中,封顶 560
  const w = sw < 600 ? sw - 44 : Math.min(560, sw * 0.62);
  const h = sw < 600 ? 50 : 56;
  return { x: sw / 2, y: EDGE + (sw < 600 ? 70 : 96), w, h };
}
function setMorphSprings(){ for (const s of [sp.cx, sp.cy, sp.bx, sp.by]) s.set(P.om, P.ze); }

// 鼠标移到屏幕右边自动展开设置面板,移开自动收起(无按钮)
document.addEventListener('mousemove', e => {
  const w = window.innerWidth;
  if (e.clientX > w - 48) document.body.classList.add('panel-open');
  else if (e.clientX < w - 320) document.body.classList.remove('panel-open');
});

stage.addEventListener('pointerdown', e => {
  if (e.target.closest('#search')) return;
  pointer = { x: e.offsetX, y: e.offsetY };
  if (state === 'CAPSULE') { retract(); return; }
  state = 'DRAG';
  document.getElementById('hint').style.opacity = 0;
  sp.cx.x = pointer.x; sp.cx.v = 0;
  sp.cy.x = EDGE * 0.5; sp.cy.v = 0;   // 从黑边里渗出来
  sp.bx.x = sp.by.x = 2;
  for (const s of [sp.cx, sp.cy]) s.set(18, 0.95);   // 跟手要紧
  for (const s of [sp.bx, sp.by]) s.set(P.om, P.ze);
  sp.dark.t = 1; sp.k.t = P.k; sp.cont.t = 0;
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', e => {
  if (state !== 'DRAG') return;
  pointer = { x: e.offsetX, y: e.offsetY };
});
stage.addEventListener('pointerup', () => {
  if (state !== 'DRAG') return;
  if (pointer.y > stage.clientHeight * 0.32) {       // 拉够了 → 胶囊
    state = 'CAPSULE'; setMorphSprings();
    const c = capsuleRect();
    sp.cx.t = c.x; sp.cy.t = c.y; sp.bx.t = c.w / 2; sp.by.t = c.h / 2;
    sp.dark.t = 0; sp.k.t = 10;                      // 材质变浅 + 与边缘脱开
    sp.cont.t = 1;                                   // 黑顶容器淡入
  } else retract();
});
addEventListener('keydown', e => { if (e.key === 'Escape' && state === 'CAPSULE') retract(); });

function retract(){
  state = 'RETRACT'; setMorphSprings();
  sp.cy.t = EDGE * 0.3; sp.bx.t = sp.by.t = 1;
  sp.dark.t = 1; sp.k.t = P.k; sp.cont.t = 0;
  document.getElementById('searchInput').blur();
}

// ---------- 主循环 ----------
const searchEl = document.getElementById('search');
let last = performance.now();
function frame(now){
  const dt = Math.min((now - last) / 1000, 1 / 30); last = now;

  if (state === 'DRAG') {
    sp.cx.t = pointer.x; sp.cy.t = Math.max(pointer.y, EDGE * 0.5);
    // 速度拉伸:液滴朝运动方向微微变长
    sp.bx.t = R + Math.min(26, Math.abs(sp.cx.v) * 0.045);
    sp.by.t = R + Math.min(26, Math.abs(sp.cy.v) * 0.045);
  }
  for (const key in sp) sp[key].step(dt);
  if (state === 'RETRACT' && sp.by.x < 2.5) state = 'IDLE';

  gl.uniform2f(U.uRes, cv.width, cv.height);
  gl.uniform4f(U.uBlob, sp.cx.x * dpr, sp.cy.x * dpr,
                        Math.max(sp.bx.x, 0.5) * dpr, Math.max(sp.by.x, 0.5) * dpr);
  gl.uniform1f(U.uEdge, EDGE * dpr);
  gl.uniform1f(U.uK, sp.k.x * dpr);
  gl.uniform1f(U.uHeight, P.height * dpr);
  gl.uniform1f(U.uRefract, P.refract * dpr);
  gl.uniform1f(U.uHlAmt, P.hl);
  gl.uniform1f(U.uAb, P.ab);
  gl.uniform1f(U.uDpr, dpr);
  gl.uniform1f(U.uDark, Math.max(0, Math.min(1, sp.dark.x)));
  gl.uniform1f(U.uCont, Math.max(0, Math.min(1, sp.cont.x)) * P.cont);
  gl.uniform1f(U.uValid, state === 'IDLE' ? 0 : 1);
  gl.uniform1f(U.uHasTex, hasTex);
  gl.uniform2f(U.uTexSize, texSize[0], texSize[1]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 搜索框 DOM 跟着弹簧矩形走(文字在弹簧落定时淡入)
  if (state === 'CAPSULE') {
    searchEl.style.left = (sp.cx.x - sp.bx.x) + 'px';
    searchEl.style.top = (sp.cy.x - sp.by.x) + 'px';
    searchEl.style.width = sp.bx.x * 2 + 'px';
    searchEl.style.height = sp.by.x * 2 + 'px';
    searchEl.style.opacity = 1;                              // 不等弹簧落定,立即显示
    searchEl.style.pointerEvents = 'auto';
    searchEl.classList.add('appear');                        // 文字/图标从 blur 中凝聚
    if (document.activeElement !== searchInput) searchInput.focus();
    updateCaret(true);
  } else { searchEl.style.opacity = 0; searchEl.style.pointerEvents = 'none';
           searchEl.classList.remove('appear'); caretEl.style.display = 'none'; }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- 发光光标:原生 caret 做不出辉光,量文本宽度自己画 ----------
const caretEl = document.getElementById('caret');
const mctx = document.createElement('canvas').getContext('2d');
let caretBlinkReset = 0;
function updateCaret(visible){
  if (!visible || document.activeElement !== searchInput) { caretEl.style.display = 'none'; return; }
  const cs = getComputedStyle(searchInput);
  mctx.font = cs.font;
  const padL = parseFloat(cs.paddingLeft) || 0;        // 跟随响应式 padding
  const upto = searchInput.value.slice(0, searchInput.selectionStart ?? searchInput.value.length);
  const x = searchInput.offsetLeft + padL + mctx.measureText(upto).width;
  caretEl.style.left = Math.min(x, searchInput.offsetLeft + searchInput.offsetWidth - 12) + 'px';
  caretEl.style.display = 'block';
}
searchInput.addEventListener('input', () => {       // 打字时光标常亮(苹果行为):重启闪烁
  caretEl.style.animation = 'none';
  clearTimeout(caretBlinkReset);
  caretBlinkReset = setTimeout(() => caretEl.style.animation = '', 80);
});

// ---------- 滑块 ----------
function bind(id, fn, fmt){
  const el = document.getElementById(id), lab = document.getElementById('v' + id);
  el.addEventListener('input', () => { fn(+el.value); lab.textContent = fmt(+el.value); });
}
bind('K',  v => { P.k = v; if (state !== 'CAPSULE') sp.k.t = v; }, v => v);
bind('LW', v => P.height = v, v => v);
bind('ST', v => P.refract = v, v => v);
bind('DM', v => P.hl = v / 100, v => (v / 100).toFixed(2));
bind('CT', v => P.cont = v / 100, v => (v / 100).toFixed(2));
bind('AB', v => P.ab = v / 100, v => (v / 100).toFixed(2));
bind('OM', v => P.om = v / 10, v => (v / 10).toFixed(1));
bind('ZE', v => P.ze = v / 100, v => (v / 100).toFixed(2));

(function(){
  var box = document.getElementById('searchInput');
  if(!box) return;
  var PRESETS = {
    Bing: 'https://www.bing.com/search?q=',
    百度: 'https://www.baidu.com/s?wd=',
    Google: 'https://www.google.com/search?q=',
    DuckDuckGo: 'https://duckduckgo.com/?q='
  };
  function engineTemplate(){
    var custom = localStorage.getItem('nt_engine_url');
    if(custom) return custom;
    var name = localStorage.getItem('nt_engine') || 'Bing';
    return PRESETS[name] || PRESETS.Bing;
  }
  box.addEventListener('keydown', function(e){
    if(e.key !== 'Enter') return;
    var q = box.value.trim(); if(!q) return;
    var looksUrl = /^https?:\/\//i.test(q) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(q);
    if(looksUrl){ window.location.href = /^https?:\/\//i.test(q) ? q : 'https://' + q; return; }
    var tpl = engineTemplate();
    if(tpl.indexOf('%s') >= 0) window.location.href = tpl.replace('%s', encodeURIComponent(q));
    else window.location.href = tpl + encodeURIComponent(q);
  });

  // 设置面板：搜索引擎联动(自定义下拉)
  var engineWrap = document.getElementById('engineWrap');
  var engineBtn = document.getElementById('engineBtn');
  var engineLabel = document.getElementById('engineLabel');
  var engineDp = document.getElementById('engineDp');
  var urlInput = document.getElementById('engineUrl');

  var ENG_LABELS = { Bing:'必应 Bing', 百度:'百度', Google:'谷歌 Google', DuckDuckGo:'DuckDuckGo', __custom__:'自定义…' };

  function syncEngineUI(){
    var custom = localStorage.getItem('nt_engine_url');
    if (engineLabel){
      if (custom) engineLabel.textContent = ENG_LABELS.__custom__;
      else {
        var name = localStorage.getItem('nt_engine') || 'Bing';
        engineLabel.textContent = ENG_LABELS[name] || ENG_LABELS.Bing;
      }
    }
    if (urlInput){
      if (custom) { urlInput.style.display = 'block'; urlInput.value = custom; }
      else { urlInput.style.display = 'none'; urlInput.value = ''; }
    }
    // 高亮当前选中项
    if (engineDp){
      var activeVal = custom ? '__custom__' : (localStorage.getItem('nt_engine') || 'Bing');
      Array.from(engineDp.children).forEach(function(o){ o.classList.toggle('active', o.dataset.val === activeVal); });
    }
  }

  if (engineBtn && engineDp){
    engineBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var wasOpen = engineWrap.classList.contains('open');
      window.closeAllDrops();
      if (!wasOpen) engineWrap.classList.add('open');
    });
    engineDp.addEventListener('click', function(e){
      var opt = e.target.closest('.c-opt'); if (!opt) return;
      var val = opt.dataset.val;
      if (val === '__custom__'){
        // 自定义:显示模板输入框并聚焦,不调 syncEngineUI(避免它按空存储把输入框藏回去)
        urlInput.style.display = 'block';
        urlInput.value = localStorage.getItem('nt_engine_url') || '';
        urlInput.focus();
        engineLabel.textContent = ENG_LABELS.__custom__;
        engineWrap.classList.remove('open');
        return;
      }
      urlInput.style.display = 'none';
      localStorage.removeItem('nt_engine_url');
      localStorage.setItem('nt_engine', val);
      syncEngineUI();
      engineWrap.classList.remove('open');
    });
  }
  syncEngineUI();
  urlInput.addEventListener('input', function(){
    var v = urlInput.value.trim();
    if(v) localStorage.setItem('nt_engine_url', v);
    else localStorage.removeItem('nt_engine_url');
  });
})();
