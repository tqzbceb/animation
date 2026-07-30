/**
 * 流畅切换动画 · Fluid Transitions
 * for SillyTavern / TauriTavern
 *
 * 给顶栏面板、左右侧边栏、弹窗、切换聊天、新消息加上手机 App 那种进出动效。
 * 只叠加动画，不改任何 DOM 结构；关掉开关立刻恢复原生行为。
 */

const EXT_ID = 'fluid-transitions';
const KEY = 'fluidTransitions';

const DEFAULTS = {
    enabled: true,
    style: 'ios',          // fade | ios | spring
    duration: 260,         // 进入动画时长 ms
    drawers: true,         // 顶栏下拉面板（API / 世界书 / 用户设置 ...）
    panels: true,          // 左右侧边栏（左侧设置栏 / 右侧角色栏）
    popups: true,          // 弹窗
    chatSwitch: true,      // 切换聊天
    messages: true,        // 新消息出现
    launch: true,          // 启动时整体淡入
    icons: true,           // 顶栏图标按下/选中反馈
    respectReduced: true,  // 跟随「减少动画」设置
    keepWarm: true,        // 关着的面板保持「算好但不画」（治点击顿挫，最关键的一条）
    keepWarmMs: 45000,     // 最后一次碰抽屉后，保持就绪多久
    prewarm: true,         // 启动后趁空闲把重面板过一遍、按下时先解码头像
    fastSwitch: true,      // 切面板不等客户端那 125ms
    lightPaint: true,      // 动画期间不画毛玻璃和文字阴影
    autoPerf: true,        // 掉帧就自动降级
};

const PRESETS = {
    fade: {
        y: 7, scale: 0.996, side: 10, sideOpacity: 0,
        ease: 'cubic-bezier(.25,.9,.3,1)', easeOut: 'cubic-bezier(.4,.05,.9,.5)',
        overshoot: false, outRatio: 0.62, popY: 6, popScale: 0.985,
    },
    ios: {
        y: 16, scale: 0.985, side: 100, sideOpacity: 1,
        ease: 'cubic-bezier(.22,1,.36,1)', easeOut: 'cubic-bezier(.36,0,.7,.2)',
        overshoot: false, outRatio: 0.66, popY: 10, popScale: 0.955,
    },
    spring: {
        y: 22, scale: 0.972, side: 100, sideOpacity: 1,
        ease: 'cubic-bezier(.16,1,.3,1)', easeOut: 'cubic-bezier(.36,0,.7,.2)',
        overshoot: true, outRatio: 0.6, popY: 14, popScale: 0.93,
    },
};

let cfg = Object.assign({}, DEFAULTS);
let drawerObserver = null;
let chatObserver = null;
let reduceQuery = null;
let swapUntil = 0;

const openState = new WeakMap();
const running = new WeakMap();

/* ---------------------------------------------------------------- 基础工具 */

function context() {
    try { return globalThis.SillyTavern?.getContext?.() ?? null; } catch { return null; }
}

function loadSettings() {
    const store = context()?.extensionSettings;
    if (store) {
        store[KEY] = Object.assign({}, DEFAULTS, store[KEY] || {});
        cfg = store[KEY];
    }
    return cfg;
}

function persist() {
    try { context()?.saveSettingsDebounced?.(); } catch { /* ignore */ }
}

function preset() {
    return PRESETS[cfg.style] || PRESETS.ios;
}

/** 自动降级：本次会话内有效，不写进设置 */
let perfMode = false;
let perfSamples = 0;

function baseDuration() {
    const d = Math.max(80, cfg.duration);
    return perfMode ? Math.min(d, 180) : d;
}

function lightPaint() {
    return !!cfg.lightPaint || perfMode;
}

let cvSupported = null;
let keepTimer = 0;

/** 你正在操作抽屉 → 让关着的面板保持就绪；停手 45s 后还原成原生 display:none */
function touchWarm() {
    if (!active() || !cfg.keepWarm || !supportsKeepWarm()) return;
    document.body.classList.add('ftx-keep');
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => document.body.classList.remove('ftx-keep'), Math.max(2000, cfg.keepWarmMs | 0));
}

/** content-visibility 是这套方案的关键，检测不到就整条跳过 */
function supportsKeepWarm() {
    if (cvSupported === null) {
        try { cvSupported = !!(globalThis.CSS?.supports?.('content-visibility', 'hidden')); }
        catch { cvSupported = false; }
    }
    return cvSupported;
}

function reducedMotion() {
    if (!cfg.respectReduced) return false;
    if (context()?.powerUserSettings?.reduced_motion) return true;
    return !!reduceQuery?.matches;
}

function active() {
    return !!cfg.enabled && !reducedMotion();
}

function isSide(el) {
    return el.classList.contains('fillLeft') || el.classList.contains('fillRight');
}

function managed(el) {
    return isSide(el) ? cfg.panels : cfg.drawers;
}

/* ------------------------------------------------------------ 关键帧生成 */

function hiddenTransform(el, p) {
    if (isSide(el)) {
        const sign = el.classList.contains('fillLeft') ? -1 : 1;
        return `translate3d(${sign * p.side}%, 0, 0)`;
    }
    return `translate3d(0, ${-p.y}px, 0) scale(${p.scale})`;
}

function overshootTransform(el) {
    if (isSide(el)) {
        const sign = el.classList.contains('fillLeft') ? 1 : -1;
        return `translate3d(${sign * 1.2}%, 0, 0)`;
    }
    return 'translate3d(0, 2px, 0) scale(1.005)';
}

function startOpacity(el, p) {
    return isSide(el) ? p.sideOpacity : 0;
}

/** 打断时的当前视觉状态 —— 从这里接着走，而不是跳回起点 */
function currentState(el) {
    const cs = getComputedStyle(el);
    return { transform: cs.transform === 'none' ? 'none' : cs.transform, opacity: cs.opacity };
}

function framesFor(el, dir, from) {
    const p = preset();
    const hidden = hiddenTransform(el, p);
    const o0 = startOpacity(el, p);
    const base = baseDuration();
    // 被打断时缩短时长：剩下的路本来就短，用原时长会显得拖
    const scale = from ? 0.7 : 1;

    if (dir === 'out') {
        return {
            keyframes: [
                from || { opacity: 1, transform: 'none' },
                { opacity: o0, transform: hidden },
            ],
            options: {
                duration: Math.max(80, Math.round(base * p.outRatio * scale)),
                easing: p.easeOut,
                fill: 'forwards',
            },
        };
    }

    const keyframes = (p.overshoot && !from)
        ? [
            { opacity: o0, transform: hidden, offset: 0 },
            { opacity: 1, transform: overshootTransform(el), offset: 0.64 },
            { opacity: 1, transform: 'none', offset: 1 },
        ]
        : [
            from || { opacity: o0, transform: hidden },
            { opacity: 1, transform: 'none' },
        ];

    return {
        keyframes,
        options: {
            duration: Math.max(80, Math.round(base * scale)),
            easing: (p.overshoot && !from) ? 'cubic-bezier(.3,0,.35,1)' : p.ease,
            fill: 'none',
        },
    };
}

/* ---------------------------------------------------------------- 播放动画 */

/** 侧边栏横向滑出会临时把页面撑宽（fixed + transform 会算进可滚动区域），
 *  动画期间把 html 的溢出掐掉，免得手机上闪一条横向滚动条。 */
let clipCount = 0;
const clipped = new WeakSet();

function clipStart() {
    clipCount += 1;
    document.documentElement.classList.add('ftx-clip');
}

function releaseClip(anim) {
    if (!clipped.has(anim)) return;
    clipped.delete(anim);
    clipCount = Math.max(0, clipCount - 1);
    if (clipCount === 0) document.documentElement.classList.remove('ftx-clip');
}

function clipReset() {
    clipCount = 0;
    document.documentElement.classList.remove('ftx-clip');
}

/** 采样一段动画的帧间隔，连续两次判定掉帧就自动降级 */
function sampleFrames(durationMs) {
    if (!cfg.autoPerf || perfMode || typeof requestAnimationFrame !== 'function') return;
    const t0 = performance.now();
    let prev = 0;
    let long = 0;
    let frames = 0;
    const tick = (ts) => {
        if (prev) {
            frames += 1;
            if (ts - prev > 34) long += 1;
        }
        prev = ts;
        if (performance.now() - t0 < durationMs + 60) {
            requestAnimationFrame(tick);
            return;
        }
        // 判定要覆盖两种慢：偶尔长帧（frames 够但 long 多），
        // 以及机器慢到整段动画只挤出一两帧（早先只看 long/frames 比例，
        // 20 倍降速下 frames < 4 直接被跳过，于是永远不会降级 —— 踩过）
        const elapsed = Math.max(1, performance.now() - t0);
        const fps = (frames * 1000) / elapsed;
        // fps 低还要配上真长帧，否则天生 30Hz 的低刷屏会被误判成卡
        const janky = frames >= 2
            && ((fps < 40 && long >= 2) || long >= Math.max(2, Math.round(frames * 0.35)));
        if (!janky) {
            // 平稳的转场把计数退回去：开机那一下的卡不该把整个会话锁进省电模式
            perfSamples = Math.max(0, perfSamples - 1);
            return;
        }
        perfSamples += 1;
        if (perfSamples >= 3) {
            perfMode = true;
            syncBody();
            console.info('[fluid-transitions] 连续检测到掉帧，已自动切到省电模式（设置里可关掉「自动降级」）');
        }
    };
    requestAnimationFrame(tick);
}

function play(el, dir) {
    const prev = running.get(el);
    let from = null;
    if (prev) {
        from = currentState(el);
        running.delete(el);
        releaseClip(prev);
        try { prev.cancel(); } catch { /* ignore */ }
    }

    const { keyframes, options } = framesFor(el, dir, from);
    let anim;
    try {
        anim = el.animate(keyframes, options);
    } catch {
        el.classList.remove('ftx-animating', 'ftx-leaving');
        return null;
    }

    el.classList.add('ftx-animating');
    running.set(el, anim);
    if (isSide(el)) { clipped.add(anim); clipStart(); }
    sampleFrames(Number(options.duration) || 200);

    anim.finished.then(() => {
        releaseClip(anim);
        if (running.get(el) !== anim) return;
        running.delete(el);
        // 先摘掉 ftx-leaving（元素随即变回 display:none），再撤掉 forwards，避免闪一帧
        el.classList.remove('ftx-leaving', 'ftx-animating');
        try { anim.cancel(); } catch { /* ignore */ }
    }, () => { /* cancelled */ });

    return anim;
}

function onDrawerOpen(el) {
    if (!active() || !managed(el)) return;
    el.classList.remove('ftx-leaving');
    play(el, 'in');
}

function onDrawerClose(el) {
    if (!active() || !managed(el)) {
        el.classList.remove('ftx-leaving', 'ftx-animating');
        return;
    }
    el.classList.add('ftx-leaving');
    if (!play(el, 'out')) el.classList.remove('ftx-leaving');
}

/* ------------------------------------------------------------ 预热与抢跑 */

const warmed = new WeakSet();

/** 把面板临时挂出来（不可见）走一遍布局与图片解码，之后再收回去。
 *  这样真正打开时浏览器不用当场画几百个节点，就没有「点了不动」那一下。 */
function prewarm(el) {
    if (!el || !cfg.prewarm || warmed.has(el)) return;
    if (el.classList.contains('openDrawer') || el.classList.contains('ftx-leaving')) return;
    warmed.add(el);
    try {
        el.style.setProperty('content-visibility', 'visible', 'important');
        el.style.setProperty('display', isSide(el) ? 'flex' : 'block', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        el.style.setProperty('height', isSide(el) ? '100%' : 'auto', 'important');
        void el.offsetHeight; // 强制一次布局
        decodeImages(el);
    } catch { /* ignore */ }
    const undo = () => {
        for (const prop of ['content-visibility', 'display', 'visibility', 'pointer-events', 'height']) {
            el.style.removeProperty(prop);
        }
    };
    // 两帧后收回：一帧布局、一帧绘制，图片解码是异步的但已经排上队了
    requestAnimationFrame(() => requestAnimationFrame(undo));
    setTimeout(undo, 400); // 兜底，别让面板卡在挂出来的状态
}

/** 头像是懒加载的，关着的时候一张都不读 —— 手机上「打开后还在渲染」就是这个。
 *  预热时顺手把前几十张读好、解好。 */
/** 一次最多提前读多少张头像。
 *  手机上必须压住：关掉缩略图时头像就是 400x600 的角色卡 PNG，
 *  一张解码出来约 1MB 位图，80 张接近 80MB，够让手机 WebView 被系统杀掉。
 *  屏幕窄或内存小就只读一屏多一点。 */
function decodeBudget() {
    // 判手机要看触屏和宽度，别用 min(宽,高)：笔记本高度常年不到 900，会被误判（踩过）
    let small = false;
    try { small = innerWidth <= 900 || matchMedia('(pointer: coarse)').matches; } catch { /* ignore */ }
    let lowMem = false;
    try { lowMem = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4; } catch { /* ignore */ }
    if (small || lowMem) return 24;
    return 80;
}

function decodeImages(el) {
    const imgs = el.querySelectorAll('img');
    const budget = decodeBudget();
    let n = 0;
    for (const img of imgs) {
        if (n >= budget) break;
        n += 1;
        try {
            if (img.loading === 'lazy') img.loading = 'eager';
            if (typeof img.decode === 'function' && img.complete) img.decode().catch(() => {});
        } catch { /* ignore */ }
    }
}

function panelForToggle(node) {
    const toggle = node.closest?.('.drawer-toggle');
    if (toggle) return toggle.parentElement?.querySelector('.drawer-content') || null;
    const opener = node.closest?.('[data-target]');
    if (opener) {
        const host = document.getElementById(opener.getAttribute('data-target'));
        return host?.querySelector('.drawer-content') || host?.classList.contains('drawer-content') ? host : null;
    }
    return null;
}

/** 手指/鼠标按下时只干最便宜的一件事：把头像的加载/解码排上队。
 *  （早先版本在这里强制整块布局，慢机器上那份活儿会跟你抬手撞在一起，反而更顿 —— 别再加回来） */
const decoded = new WeakSet();

function onPointerDown(e) {
    if (!active()) return;
    const node = e.target;
    if (!(node instanceof Element)) return;
    const panel = panelForToggle(node);
    if (!panel) return;
    touchWarm(); // 保持就绪跟 prewarm 是两码事，不要被它的开关挡住
    if (!cfg.prewarm || !managed(panel) || decoded.has(panel)) return;
    decoded.add(panel);
    decodeImages(panel);
}

/** 抢跑：客户端在「有面板开着」时会硬等 125ms 再开新面板。
 *  我们在它的处理器之前（捕获阶段）就把旧面板标成关闭 —— 它一看没有开着的面板，
 *  就跳过那段等待，新面板立刻开始进场，形成交叠切换。 */
function onToggleCapture(e) {
    if (!active()) return;
    const node = e.target;
    if (!(node instanceof Element)) return;
    const target = panelForToggle(node);
    if (!target) return;
    touchWarm(); // 键盘/脚本触发的开关也算「正在操作抽屉」
    if (!cfg.fastSwitch || target.classList.contains('openDrawer')) return;

    const others = document.querySelectorAll('.drawer-content.openDrawer:not(.pinnedOpen)');
    if (!others.length) return;
    for (const el of others) {
        if (el === target) continue;
        el.classList.remove('openDrawer');
        el.classList.add('closedDrawer');
    }
    for (const icon of document.querySelectorAll('.drawer-icon.openIcon:not(.drawerPinnedOpen)')) {
        icon.classList.remove('openIcon');
        icon.classList.add('closedIcon');
    }
}

/** 启动后趁空闲把重面板预热一遍（错开，别抢启动的资源） */
function warmAllWhenIdle() {
    if (!cfg.prewarm) return;
    const ids = ['right-nav-panel', 'left-nav-panel', 'rm_api_block', 'WorldInfo', 'user-settings-block'];
    ids.forEach((id, i) => {
        setTimeout(() => {
            const el = document.getElementById(id);
            if (!el || el.classList.contains('openDrawer')) return;
            const run = () => prewarm(el);
            if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
            else run();
        }, 1500 + i * 500);
    });
}

/* -------------------------------------------------------- 抽屉状态观察器 */

function seedDrawerState() {
    for (const el of document.querySelectorAll('.drawer-content')) {
        openState.set(el, el.classList.contains('openDrawer'));
    }
}

function startDrawerObserver() {
    if (drawerObserver) return;
    seedDrawerState();
    drawerObserver = new MutationObserver((records) => {
        for (const rec of records) {
            const el = rec.target;
            if (!(el instanceof HTMLElement) || !el.classList.contains('drawer-content')) continue;
            const isOpen = el.classList.contains('openDrawer');
            if (openState.get(el) === isOpen) continue;
            openState.set(el, isOpen);
            isOpen ? onDrawerOpen(el) : onDrawerClose(el);
        }
    });
    drawerObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
}

/* ------------------------------------------------------ 聊天切换 / 新消息 */

function animateChatSwap() {
    const chat = document.getElementById('chat');
    if (!chat || !active() || !cfg.chatSwitch) return;
    const p = preset();
    swapUntil = performance.now() + cfg.duration + 150;
    try {
        chat.animate(
            [
                { opacity: 0, transform: `translate3d(0, ${Math.round(p.y * 0.9)}px, 0)` },
                { opacity: 1, transform: 'none' },
            ],
            { duration: Math.max(120, Math.round(cfg.duration * 1.1)), easing: p.ease },
        );
    } catch { /* ignore */ }
}

function animateMessage(el) {
    const p = preset();
    try {
        el.animate(
            [
                { opacity: 0, transform: `translate3d(0, ${Math.max(6, Math.round(p.y * 0.7))}px, 0)` },
                { opacity: 1, transform: 'none' },
            ],
            { duration: Math.max(120, Math.round(cfg.duration * 0.85)), easing: p.ease },
        );
    } catch { /* ignore */ }
}

let launched = false;

/** 启动时整体淡入一次（对应「打开程序」那种感觉） */
function animateLaunch() {
    if (launched) return;
    launched = true;
    if (!active() || !cfg.launch) return;
    const p = preset();
    const dur = Math.round(Math.max(120, cfg.duration) * 1.5);
    const targets = ['top-bar', 'top-settings-holder', 'sheld']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    targets.forEach((el, i) => {
        try {
            el.animate(
                [
                    { opacity: 0, transform: `translate3d(0, ${Math.round(p.y * 0.7)}px, 0)` },
                    { opacity: 1, transform: 'none' },
                ],
                { duration: dur, delay: i * 45, easing: p.ease, fill: 'backwards' },
            );
        } catch { /* ignore */ }
    });
}

function startChatObserver() {
    const chat = document.getElementById('chat');
    if (!chat || chatObserver?.ftxTarget === chat) return;
    chatObserver?.disconnect();
    chatObserver = new MutationObserver((records) => {
        if (!active() || !cfg.messages) return;
        if (performance.now() < swapUntil) return;
        const added = [];
        for (const rec of records) {
            for (const node of rec.addedNodes) {
                if (node instanceof HTMLElement && node.classList.contains('mes')) added.push(node);
            }
        }
        // 一次塞进来一堆 = 整个聊天在重绘，交给切换聊天的动画处理
        if (!added.length || added.length > 3) return;
        added.forEach(animateMessage);
    });
    chatObserver.ftxTarget = chat;
    chatObserver.observe(chat, { childList: true });
}

/* ------------------------------------------------------------ 状态同步 */

function syncBody() {
    const on = active();
    const body = document.body;
    const root = document.documentElement;
    const p = preset();

    body.classList.toggle('ftx-on', on);
    body.classList.toggle('ftx-drawers', on && !!cfg.drawers);
    body.classList.toggle('ftx-panels', on && !!cfg.panels);
    body.classList.toggle('ftx-popups', on && !!cfg.popups);
    body.classList.toggle('ftx-icons', on && !!cfg.icons);
    body.classList.toggle('ftx-noblur', on && lightPaint());
    body.classList.toggle('ftx-light', on && lightPaint());
    body.classList.toggle('ftx-perf', on && perfMode);
    if (!on || !cfg.keepWarm || !supportsKeepWarm()) {
        clearTimeout(keepTimer);
        body.classList.remove('ftx-keep');
    }

    root.style.setProperty('--ftx-dur', `${baseDuration()}ms`);
    root.style.setProperty('--ftx-dur-out', `${Math.max(80, Math.round(baseDuration() * p.outRatio))}ms`);
    root.style.setProperty('--ftx-ease', p.ease);
    root.style.setProperty('--ftx-ease-out', p.easeOut);
    root.style.setProperty('--ftx-pop-y', `${p.popY}px`);
    root.style.setProperty('--ftx-pop-scale', String(p.popScale));

    if (!on) {
        for (const el of document.querySelectorAll('.ftx-leaving, .ftx-animating')) {
            el.classList.remove('ftx-leaving', 'ftx-animating');
        }
        clipReset();
    }
}

/* ---------------------------------------------------------------- 设置面板 */

const SETTINGS_HTML = `
<div class="ftx-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>流畅切换动画</b>
            <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="ftx_enabled">
                <input id="ftx_enabled" type="checkbox" data-ftx="enabled">
                <span>启用动画</span>
            </label>

            <label for="ftx_style">动效风格</label>
            <select id="ftx_style" class="text_pole" data-ftx="style">
                <option value="fade">轻快（淡入淡出）</option>
                <option value="ios">顺滑（推入，类手机）</option>
                <option value="spring">弹性（带回弹）</option>
            </select>

            <label for="ftx_duration">时长 <span class="ftx-value">260ms</span></label>
            <input id="ftx_duration" type="range" min="120" max="480" step="10" data-ftx="duration">

            <div class="ftx-group-title">应用范围</div>
            <label class="checkbox_label" for="ftx_drawers">
                <input id="ftx_drawers" type="checkbox" data-ftx="drawers">
                <span>顶栏下拉面板（API / 世界书 / 用户设置…）</span>
            </label>
            <label class="checkbox_label" for="ftx_panels">
                <input id="ftx_panels" type="checkbox" data-ftx="panels">
                <span>左右侧边栏（设置栏 / 角色栏）</span>
            </label>
            <label class="checkbox_label" for="ftx_popups">
                <input id="ftx_popups" type="checkbox" data-ftx="popups">
                <span>弹窗</span>
            </label>
            <label class="checkbox_label" for="ftx_chatSwitch">
                <input id="ftx_chatSwitch" type="checkbox" data-ftx="chatSwitch">
                <span>切换聊天 / 角色</span>
            </label>
            <label class="checkbox_label" for="ftx_messages">
                <input id="ftx_messages" type="checkbox" data-ftx="messages">
                <span>新消息出现</span>
            </label>

            <label class="checkbox_label" for="ftx_launch">
                <input id="ftx_launch" type="checkbox" data-ftx="launch">
                <span>启动时整体淡入</span>
            </label>
            <label class="checkbox_label" for="ftx_icons">
                <input id="ftx_icons" type="checkbox" data-ftx="icons">
                <span>顶栏图标按下 / 选中反馈</span>
            </label>

            <div class="ftx-group-title">响应速度</div>
            <label class="checkbox_label" for="ftx_keepWarm">
                <input id="ftx_keepWarm" type="checkbox" data-ftx="keepWarm">
                <span>关着的面板保持就绪（点击不再顿挫，最重要的一条）</span>
            </label>
            <label class="checkbox_label" for="ftx_prewarm">
                <input id="ftx_prewarm" type="checkbox" data-ftx="prewarm">
                <span>提前加载头像（手机上打开后不再一点点渲染）</span>
            </label>
            <label class="checkbox_label" for="ftx_fastSwitch">
                <input id="ftx_fastSwitch" type="checkbox" data-ftx="fastSwitch">
                <span>切面板不等待（去掉客户端的 125ms 空档）</span>
            </label>
            <label class="checkbox_label" for="ftx_lightPaint">
                <input id="ftx_lightPaint" type="checkbox" data-ftx="lightPaint">
                <span>省电绘制：动画期间不画毛玻璃和文字阴影</span>
            </label>
            <label class="checkbox_label" for="ftx_autoPerf">
                <input id="ftx_autoPerf" type="checkbox" data-ftx="autoPerf">
                <span>掉帧时自动降级</span>
            </label>

            <div class="ftx-group-title">其他</div>
            <label class="checkbox_label" for="ftx_respectReduced">
                <input id="ftx_respectReduced" type="checkbox" data-ftx="respectReduced">
                <span>跟随「减少动画」设置自动关闭</span>
            </label>

            <div class="ftx-actions">
                <div id="ftx_preview" class="menu_button">预览一次</div>
                <div id="ftx_reset" class="menu_button">恢复默认</div>
            </div>
            <small class="ftx-hint">动画只是叠加在原生行为之上，随时可关；手机和电脑用同一套设置。</small>
        </div>
    </div>
</div>`;

function fillUI() {
    const root = document.querySelector('.ftx-settings');
    if (!root) return;
    for (const el of root.querySelectorAll('[data-ftx]')) {
        const key = el.dataset.ftx;
        if (el.type === 'checkbox') el.checked = !!cfg[key];
        else el.value = String(cfg[key]);
    }
    const label = root.querySelector('.ftx-value');
    if (label) label.textContent = `${cfg.duration}ms`;
}

function previewOnce() {
    const target = document.querySelector('.drawer-content.openDrawer:not(.pinnedOpen)')
        || document.getElementById('rm_extensions_block');
    if (!target) return;
    const wasOn = cfg.enabled;
    cfg.enabled = true;
    play(target, 'in');
    cfg.enabled = wasOn;
}

function mountSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || host.querySelector('.ftx-settings')) return false;

    host.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    const root = host.querySelector('.ftx-settings');

    root.addEventListener('input', (e) => {
        const el = e.target;
        if (!(el instanceof HTMLElement) || !el.dataset.ftx) return;
        const key = el.dataset.ftx;
        if (el.type === 'checkbox') cfg[key] = el.checked;
        else if (el.type === 'range') cfg[key] = Number(el.value);
        else cfg[key] = el.value;
        const label = root.querySelector('.ftx-value');
        if (label) label.textContent = `${cfg.duration}ms`;
        syncBody();
        persist();
    });

    root.querySelector('#ftx_preview')?.addEventListener('click', previewOnce);
    root.querySelector('#ftx_reset')?.addEventListener('click', () => {
        Object.assign(cfg, DEFAULTS);
        fillUI();
        syncBody();
        persist();
    });

    fillUI();
    return true;
}

function mountSettingsWhenReady(tries = 40) {
    if (mountSettings() || tries <= 0) return;
    setTimeout(() => mountSettingsWhenReady(tries - 1), 250);
}

/* -------------------------------------------------------------------- 生命周期 */

function teardown() {
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    document.removeEventListener('touchstart', onPointerDown, { capture: true });
    document.removeEventListener('click', onToggleCapture, true);
    drawerObserver?.disconnect();
    drawerObserver = null;
    chatObserver?.disconnect();
    chatObserver = null;
    for (const el of document.querySelectorAll('.ftx-leaving, .ftx-animating')) {
        const anim = running.get(el);
        if (anim) { running.delete(el); try { anim.cancel(); } catch { /* ignore */ } }
        el.classList.remove('ftx-leaving', 'ftx-animating');
    }
    clipReset();
    document.body.classList.remove('ftx-on', 'ftx-drawers', 'ftx-panels', 'ftx-popups', 'ftx-noblur', 'ftx-icons', 'ftx-light', 'ftx-perf', 'ftx-keep');
}

function init() {
    loadSettings();
    try {
        reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
        reduceQuery.addEventListener('change', syncBody);
    } catch { /* ignore */ }

    syncBody();
    startDrawerObserver();
    startChatObserver();

    const ctx = context();
    const ev = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (ev && types) {
        if (types.CHAT_CHANGED) {
            ev.on(types.CHAT_CHANGED, () => { animateChatSwap(); startChatObserver(); });
        }
        if (types.SETTINGS_UPDATED) {
            ev.on(types.SETTINGS_UPDATED, () => { loadSettings(); syncBody(); fillUI(); });
        }
        if (types.APP_READY) {
            ev.on(types.APP_READY, () => { seedDrawerState(); startChatObserver(); animateLaunch(); });
        }
    }
    // 用户在「用户设置」里勾选/取消「减少动画」时同步
    document.getElementById('reduced_motion')?.addEventListener('change', () => setTimeout(syncBody, 0));

    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    document.addEventListener('touchstart', onPointerDown, { capture: true, passive: true });
    document.addEventListener('click', onToggleCapture, true);

    mountSettingsWhenReady();
    warmAllWhenIdle();
    // APP_READY 没来（老版本 / 加载顺序意外）也别让首屏卡在透明状态
    setTimeout(animateLaunch, 3000);

    globalThis.fluidTransitions = {
        cfg: () => cfg,
        defaults: () => Object.assign({}, DEFAULTS),
        apply: syncBody,
        play,
        preview: previewOnce,
        launch: () => { launched = false; animateLaunch(); },
        teardown,
        init,
        perf: () => ({ perfMode, perfSamples }),
        setPerf: (v) => { perfMode = !!v; syncBody(); },
        prewarm,
        keepWarmSupported: supportsKeepWarm,
        version: '1.2.0',
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
