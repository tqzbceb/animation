/**
 * 流畅切换动画 · Fluid Transitions
 * for SillyTavern / TauriTavern
 *
 * 给顶栏面板、左右侧边栏、弹窗、切换聊天、新消息加上手机 App 那种进出动效。
 * 只叠加动画，不改任何 DOM 结构；关掉开关立刻恢复原生行为。
 */

const EXT_ID = 'fluid-transitions';
const KEY = 'fluidTransitions';
const VERSION = '1.5.0';

const DEFAULTS = {
    enabled: true,
    style: 'ios',          // fade | ios | spring
    duration: 220,         // 进入动画时长 ms（手机首次装会自动降到 170）
    drawers: true,         // 顶栏下拉面板（API / 世界书 / 用户设置 ...）
    panels: true,          // 左右侧边栏（左侧设置栏 / 右侧角色栏）
    popups: true,          // 弹窗
    chatSwitch: true,      // 切换聊天
    messages: true,        // 新消息出现
    launch: true,          // 启动时整体淡入
    icons: true,           // 顶栏图标按下/选中反馈
    respectReduced: true,  // 跟随「减少动画」设置
    blurSafe: true,        // 只动面板里的内容，不动带毛玻璃的面板本体（默认，见下）
    solidWhileMoving: false,// 动画期间用不透明底代替毛玻璃（blurSafe 关掉时才有意义）
    noBlurAlways: false,   // 永久不要毛玻璃（最省，但静止时也没有质感）
    fadeOnly: false,       // 面板只淡入淡出、不位移（毛玻璃采样区域不动，最省）
    closeAnim: false,      // 关闭面板时也做动画（会强制重排一次，手机上很贵，默认关）
    lightPaint: true,      // 动画期间不画文字阴影
    schema: 5,
};

/** v1.2 那套「提速」整体撤掉了：keepWarm / prewarm / fastSwitch / autoPerf 全部删除。
 *  它们针对的是「几百张角色卡的排版」，而真机上的瓶颈是绘制（全屏毛玻璃逐帧重算），
 *  在手机上净收益为负，还引入了雾蒙蒙、闪帧和快速切换崩溃。别再加回来。 */
const SCHEMA = 5;

function isPhone() {
    try { return innerWidth <= 900 || matchMedia('(pointer: coarse)').matches; }
    catch { return false; }
}

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
        const prev = store[KEY] || {};
        const merged = Object.assign({}, DEFAULTS, prev);
        if (prev.schema !== SCHEMA) {
            // 老配置里那几个开关已经不存在了，顺手清掉，时长按设备重置一次
            for (const k of ['keepWarm', 'keepWarmMs', 'prewarm', 'fastSwitch', 'autoPerf']) delete merged[k];
            const phone = isPhone();
            merged.duration = phone ? 140 : 220;
            merged.closeAnim = false;
            // v1.5：blurSafe 取代了「换实色底」那条路 —— 毛玻璃层根本不参与动画，
            // 就不用替换它，也就不会跟主题的底色规则打架（用户实测：换底色在他的主题上
            // 挡不住背后文字，因为主题用了权重更高的选择器）。两个旧开关一并归零。
            merged.blurSafe = true;
            merged.solidWhileMoving = false;
            merged.noBlurAlways = false;
            // 手机上位移会让毛玻璃每帧换采样区域，默认只做淡入
            merged.fadeOnly = phone;
            merged.schema = SCHEMA;
        }
        store[KEY] = merged;
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

function baseDuration() {
    return Math.max(80, cfg.duration);
}

/* ------------------------------------------------ 毛玻璃 → 同色不透明底

   毛玻璃的含义是「把背后的画面实时模糊一遍」，面板一动，背后被采样的区域每帧都在变，
   于是每帧都要重算一次模糊 —— 手机上这是全场最贵的一笔。
   但直接把它关掉是错的：主题的面板底色通常是半透明的，靠模糊来遮挡，
   一关就能看见背后的聊天文字透上来（用户实测反馈）。
   正确做法是换成「同色但不透明」的底：遮挡照旧、模糊成本归零。
   颜色只在启动和主题变化时算一次，绝不在动画过程里读计算样式。               */

function parseRGB(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '');
    if (!m) return null;
    const n = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (n.length < 3 || n.slice(0, 3).some(Number.isNaN)) return null;
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 && !Number.isNaN(n[3]) ? n[3] : 1 };
}

/** 底色只有一个可靠来源：主题变量 --SmartThemeBlurTintColor
 *  （客户端就是用它给 .drawer-content 上底色的）。
 *  把它的透明度拉满就得到「同色不透明」，绝不去猜背后垫什么颜色 ——
 *  早先版本拿 body 背景混合、混不出来就退回硬编码的深色，
 *  结果在浅色主题上糊出一块黑（用户实测「直接黑一块」）。
 *  算不出来就什么都不做，宁可保留原生毛玻璃。 */
/** 透明是「没有颜色信息」，不是黑色。
 *  把 rgba(0,0,0,0) 的 alpha 拉满会得到纯黑 —— 浅色主题上就是那块黑（踩过两次）。 */
function usable(c) {
    return !!c && c.a > 0.05;
}

function computeSolid() {
    const root = document.documentElement;
    let c = null;
    try {
        c = parseRGB(getComputedStyle(root).getPropertyValue('--SmartThemeBlurTintColor'));
    } catch { /* ignore */ }
    if (!usable(c)) {
        // 退一步从真正的抽屉面板上读（别读 #movingDivs 里那些同名 class 的东西）
        const panel = document.querySelector('.drawer-content.openDrawer, .drawer-content.closedDrawer');
        if (panel) {
            try { c = parseRGB(getComputedStyle(panel).backgroundColor); } catch { /* ignore */ }
        }
    }
    if (!usable(c)) {
        root.style.removeProperty('--ftx-solid');
        document.body?.classList.remove('ftx-has-solid');
        return false;
    }
    const v = (x) => Math.max(0, Math.min(255, Math.round(x)));
    root.style.setProperty('--ftx-solid', `rgb(${v(c.r)}, ${v(c.g)}, ${v(c.b)})`);
    document.body?.classList.add('ftx-has-solid');
    return true;
}

function lightPaint() {
    return !!cfg.lightPaint;
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

function framesFor(el, dir) {
    const p = preset();
    const fade = !!cfg.fadeOnly;
    const hidden = fade ? 'none' : hiddenTransform(el, p);
    const o0 = fade ? 0 : startOpacity(el, p);
    const base = baseDuration();
    const bounce = p.overshoot && !fade;

    // fill 一律用 both：
    //   进场 —— 第一帧（透明+偏移）在动画真正开跑之前就生效。
    //   早先写 fill:'none'，于是有一帧是「面板已按最终样子画出来」，
    //   手机上一帧就是三五十毫秒，看起来就是点一下闪一下（用户实测）。
    //   离场 —— 结束后按住隐藏状态，别在客户端收走之前弹回来。
    //   顺带让 reverse() 打断时两头都有明确的状态可停。
    if (dir === 'out') {
        return {
            keyframes: [
                { opacity: 1, transform: 'none' },
                { opacity: o0, transform: hidden },
            ],
            options: {
                duration: Math.max(80, Math.round(base * p.outRatio)),
                easing: p.easeOut,
                fill: 'both',
            },
        };
    }

    const keyframes = bounce
        ? [
            { opacity: o0, transform: hidden, offset: 0 },
            { opacity: 1, transform: overshootTransform(el), offset: 0.64 },
            { opacity: 1, transform: 'none', offset: 1 },
        ]
        : [
            { opacity: o0, transform: hidden },
            { opacity: 1, transform: 'none' },
        ];

    return {
        keyframes,
        options: {
            duration: Math.max(80, base),
            easing: bounce ? 'cubic-bezier(.3,0,.35,1)' : p.ease,
            fill: 'both',
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

/** 动画到底挂在谁身上 —— v1.5 唯一的实质改动。
 *
 *  毛玻璃（backdrop-filter）长在面板本体（.drawer-content）上。一旦对这个元素做
 *  opacity / transform，浏览器就必须把它提成合成层，并且逐帧重新采样背后的画面。
 *  手机 WebView 上这个层往往要等几帧才就绪，于是：先是什么都画不出来（面板消失），
 *  等就绪了才啪一下把毛玻璃贴上 —— 正是用户实测的
 *  「开始会短暂看不见，然后闪一下出现毛玻璃」。
 *
 *  所以默认改成：**带毛玻璃的那层从头到尾一动不动**，只让它里面的内容做动画。
 *  - 毛玻璃只在面板出现的那一刻算一次，不再逐帧重算（成本比换实色底还低）。
 *  - 不用去改主题的底色，也就不会输给主题里 ID + !important 的规则。
 *  代价：面板的底瞬间就位，只有内容淡入 / 滑入。手机上面板是整屏的，
 *  观感是「背景先到位、内容跟上」，比整块闪一下干净。
 *
 *  不做 DOM 改造（不加包装层）：直接对所有直接子节点用同一份关键帧，
 *  它们同步同幅移动，视觉上等于整组在动。 */
function animTargets(el) {
    if (!cfg.blurSafe) return [el];
    const kids = [];
    for (const k of el.children) {
        if (k.nodeType !== 1) continue;
        if (k.tagName === 'STYLE' || k.tagName === 'SCRIPT' || k.tagName === 'TEMPLATE') continue;
        if (k.hidden) continue;
        kids.push(k);
    }
    // 空面板（或结构意外）就退回动本体，至少还有动画
    return kids.length ? kids : [el];
}

function play(el, dir) {
    const prev = running.get(el);
    if (prev) {
        if (prev.dir === dir) return prev.anim; // 同方向又触发一次，别重来
        // 打断就让原动画反向播。这一步不读任何样式，纯粹是合成器的事。
        // 早先的写法是 getComputedStyle() 取当前位置再重建动画 —— 那会强制浏览器
        // 立刻重算整个文档的样式和布局，而快速切换时每一下都在打断，
        // 于是越切越卡（用户实测「多个面板快速切换卡到按不动」）。别再改回去。
        prev.dir = dir;
        for (const a of prev.anims) { try { a.reverse(); } catch { /* ignore */ } }
        return prev.anim;
    }

    const { keyframes, options } = framesFor(el, dir);
    const anims = [];
    for (const t of animTargets(el)) {
        try { anims.push(t.animate(keyframes, options)); } catch { /* ignore */ }
    }
    if (!anims.length) {
        el.classList.remove('ftx-animating', 'ftx-leaving');
        return null;
    }

    const anim = anims[0]; // 代表动画：clip 计数和外部返回值都用它
    const rec = { anim, anims, dir };
    el.classList.add('ftx-animating');
    running.set(el, rec);
    if (isSide(el)) { clipped.add(anim); clipStart(); }

    // allSettled：某个子节点被客户端换掉导致它的动画被 cancel 时，
    // 收尾逻辑照样要跑（否则 ftx-leaving / clip 会永久留着）。
    Promise.allSettled(anims.map((a) => a.finished)).then(() => {
        releaseClip(anim);
        if (running.get(el) !== rec) return;
        running.delete(el);
        // 先摘掉 ftx-leaving（元素随即回到 display:none），再撤掉 fill，避免闪一帧
        el.classList.remove('ftx-leaving', 'ftx-animating');
        for (const a of anims) { try { a.cancel(); } catch { /* ignore */ } }
    });

    return anim;
}

function onDrawerOpen(el) {
    if (!active() || !managed(el)) return;
    el.classList.remove('ftx-leaving');
    play(el, 'in');
}

function onDrawerClose(el) {
    // 关闭动画的代价：客户端已经把面板移出布局了（display:none），
    // 要播离场就得用 .ftx-leaving 把它强行塞回去 —— 那是一次完整的重排，
    // 手机上打开一个几百个控件的设置面板本来就慢，收回时再来一次就是
    // 用户说的「收回动画卡的离谱」。所以默认不播，交回原生的瞬间消失。
    if (!active() || !managed(el) || !cfg.closeAnim) {
        el.classList.remove('ftx-leaving', 'ftx-animating');
        const rec = running.get(el);
        if (rec) { running.delete(el); releaseClip(rec.anim); try { rec.anim.cancel(); } catch { /* ignore */ } }
        return;
    }
    el.classList.add('ftx-leaving');
    if (!play(el, 'out')) el.classList.remove('ftx-leaving');
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
    body.classList.toggle('ftx-light', on && lightPaint());
    // blurSafe 开着时绝不换底色：面板本体不参与动画，换底色只会在动画头尾各闪一次
    // （毛玻璃 → 实色 → 毛玻璃），那正是要消灭的现象。两者互斥，从这里锁住。
    body.classList.toggle('ftx-solid', on && !!cfg.solidWhileMoving && !cfg.blurSafe);
    body.classList.toggle('ftx-noblur-always', on && !!cfg.noBlurAlways);

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

            <div class="ftx-group-title">流畅度（手机上最关键的一组）</div>
            <label class="checkbox_label" for="ftx_blurSafe">
                <input id="ftx_blurSafe" type="checkbox" data-ftx="blurSafe">
                <span>只让面板里的内容动，面板本体和毛玻璃不动（推荐；毛玻璃不会再闪一下才出现）</span>
            </label>
            <label class="checkbox_label" for="ftx_solidWhileMoving">
                <input id="ftx_solidWhileMoving" type="checkbox" data-ftx="solidWhileMoving">
                <span>动画期间用同色不透明底代替毛玻璃（仅在上一项关掉时生效）</span>
            </label>
            <label class="checkbox_label" for="ftx_noBlurAlways">
                <input id="ftx_noBlurAlways" type="checkbox" data-ftx="noBlurAlways">
                <span>永久不要毛玻璃（最省；静止时也是实色底）</span>
            </label>
            <label class="checkbox_label" for="ftx_fadeOnly">
                <input id="ftx_fadeOnly" type="checkbox" data-ftx="fadeOnly">
                <span>面板只淡入淡出、不位移（动效弱一些，但最省）</span>
            </label>
            <label class="checkbox_label" for="ftx_closeAnim">
                <input id="ftx_closeAnim" type="checkbox" data-ftx="closeAnim">
                <span>关闭面板时也做动画（会明显变卡，手机建议不开）</span>
            </label>
            <label class="checkbox_label" for="ftx_lightPaint">
                <input id="ftx_lightPaint" type="checkbox" data-ftx="lightPaint">
                <span>动画期间不画文字阴影</span>
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

            <div class="ftx-group-title">诊断读数</div>
            <textarea id="ftx_diag" class="text_pole ftx-diag" rows="3" readonly></textarea>
            <div class="ftx-actions">
                <div id="ftx_diag_refresh" class="menu_button">刷新读数</div>
                <div id="ftx_diag_copy" class="menu_button">复制</div>
            </div>
            <small class="ftx-hint">手机上看不了控制台：外观有问题时，先打开出问题的那个面板，
            再回来点「刷新读数」，把这行字发给我，就能定位到是主题、开关还是插件的问题。</small>

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

/* ------------------------------------------------------ 诊断读数（手机没有控制台）
   用户只有手机，开不了控制台，所以任何"看起来不对"都必须能靠一行字定位。
   最关键的三个字段：
     bgA    面板底色的不透明度 —— 关掉毛玻璃后如果 bgA < 1，就是主题的底色规则
            权重压过了我们的，背后文字会透上来（v1.4 真机故障就是这个）。
     blur   毛玻璃此刻是开着还是被关掉。
     mid    动画进行中采一帧：p=面板本体上的动画数、k=第一个子节点上的动画数。
            blurSafe 生效时必须是 p0/k1 —— 面板本体一个动画都不许有。 */

function n(v) { return v ? 1 : 0; }

function panelForDiag() {
    return document.querySelector('.drawer-content.openDrawer:not(.pinnedOpen)')
        || document.querySelector('.drawer-content.openDrawer')
        || document.querySelector('.drawer-content.closedDrawer');
}

function diagStatic() {
    const b = document.body?.classList;
    const rootCS = getComputedStyle(document.documentElement);
    const tint = parseRGB(rootCS.getPropertyValue('--SmartThemeBlurTintColor'));
    const solid = rootCS.getPropertyValue('--ftx-solid').trim();
    const panel = panelForDiag();
    let bgA = '?', blur = '?', shadow = '?', kids = 0, id = 'none';
    if (panel) {
        id = panel.id || 'noid';
        kids = panel.children.length;
        const cs = getComputedStyle(panel);
        const bg = parseRGB(cs.backgroundColor);
        bgA = bg ? bg.a.toFixed(2) : '?';
        const bd = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
        blur = /\d/.test(bd) ? 'yes' : 'no';
        const bs = cs.boxShadow || 'none';
        shadow = /inset/.test(bs) ? 'inset' : (bs === 'none' ? 'no' : 'other');
    }
    return [
        `ftx v${VERSION}`,
        `sty=${cfg.style}`, `dur=${cfg.duration}`,
        `safe=${n(cfg.blurSafe)}`, `fade=${n(cfg.fadeOnly)}`,
        `solid=${n(cfg.solidWhileMoving)}`, `noblur=${n(cfg.noBlurAlways)}`, `close=${n(cfg.closeAnim)}`,
        `on=${n(b?.contains('ftx-on'))}`, `hasSolid=${n(b?.contains('ftx-has-solid'))}`,
        `tint=${tint ? `${tint.r},${tint.g},${tint.b}@${tint.a}` : 'none'}`,
        `calc=${solid ? solid.replace(/\s+/g, '') : 'none'}`,
        `panel=${id}`, `kids=${kids}`, `bgA=${bgA}`, `blur=${blur}`, `shadow=${shadow}`,
        `phone=${n(isPhone())}`, `reduced=${n(reducedMotion())}`, `vw=${innerWidth}`,
    ].join(' ');
}

async function diagRefresh() {
    const box = document.getElementById('ftx_diag');
    if (!box) return;
    const panel = panelForDiag();
    if (!panel || !panel.classList.contains('openDrawer')) {
        box.value = `${diagStatic()} mid=n/a(先打开一个面板再刷新)`;
        return;
    }
    box.value = `${diagStatic()} mid=采样中…`;
    const wasOn = cfg.enabled;
    cfg.enabled = true;
    play(panel, 'in');
    cfg.enabled = wasOn;
    await new Promise((r) => setTimeout(r, Math.min(140, Math.max(40, Math.round(baseDuration() / 3)))));
    const p = panel.getAnimations().length;          // 只算挂在本体上的，不含后代
    const kid = panel.firstElementChild;
    const k = kid ? kid.getAnimations().length : 0;
    const op = kid ? Number(getComputedStyle(kid).opacity) : 1;
    box.value = `${diagStatic()} mid=p${p}/k${k}/op${op.toFixed(2)}`;
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
    root.querySelector('#ftx_diag_refresh')?.addEventListener('click', diagRefresh);
    root.querySelector('#ftx_diag_copy')?.addEventListener('click', async () => {
        const box = root.querySelector('#ftx_diag');
        if (!box) return;
        if (!box.value) await diagRefresh();
        try {
            await navigator.clipboard.writeText(box.value);
            context()?.toastr?.info?.('读数已复制');
        } catch {
            // 手机浏览器可能不给剪贴板权限：选中让用户自己长按复制
            box.removeAttribute('readonly');
            box.focus();
            box.select();
            box.setAttribute('readonly', '');
        }
    });
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
    drawerObserver?.disconnect();
    drawerObserver = null;
    chatObserver?.disconnect();
    chatObserver = null;
    for (const el of document.querySelectorAll('.ftx-leaving, .ftx-animating')) {
        const rec = running.get(el);
        if (rec) {
            running.delete(el);
            for (const a of rec.anims) { try { a.cancel(); } catch { /* ignore */ } }
        }
        el.classList.remove('ftx-leaving', 'ftx-animating');
    }
    clipReset();
    document.body.classList.remove('ftx-on', 'ftx-drawers', 'ftx-panels', 'ftx-popups',
        'ftx-icons', 'ftx-light', 'ftx-solid', 'ftx-noblur-always', 'ftx-has-solid');
}

function init() {
    loadSettings();
    try {
        reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
        reduceQuery.addEventListener('change', syncBody);
    } catch { /* ignore */ }

    computeSolid();
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
            // 主题换了色调，不透明底要跟着重算（只有这种时候才算，动画里绝不算）
            ev.on(types.SETTINGS_UPDATED, () => { loadSettings(); computeSolid(); syncBody(); fillUI(); });
        }
        if (types.APP_READY) {
            ev.on(types.APP_READY, () => { seedDrawerState(); computeSolid(); startChatObserver(); animateLaunch(); });
        }
    }
    // 用户在「用户设置」里勾选/取消「减少动画」时同步
    document.getElementById('reduced_motion')?.addEventListener('change', () => setTimeout(syncBody, 0));

    mountSettingsWhenReady();
    // 主题往往在插件之后才应用，隔一会儿再算一次底色
    setTimeout(computeSolid, 1200);
    setTimeout(computeSolid, 4000);
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
        recolor: computeSolid,
        solid: () => getComputedStyle(document.documentElement).getPropertyValue('--ftx-solid').trim(),
        version: VERSION,
        diag: diagStatic,
        diagRefresh,
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
