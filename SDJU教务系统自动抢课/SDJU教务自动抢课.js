// ==UserScript==
// @name         SDJU教务自动抢课
// @namespace    https://github.com/userlxn/tampermonkey-scripts
// @license      MIT
// @version      1.5.3
// @description  SDJU教务自动抢课（仅在选课页面生效）：速度档位可选（极速/快速/标准/保守）、持续抢课+自动停止时间、网课专区（尔雅/智慧树）、已选课程时间冲突预检、定时开抢、可视化控制台
// @author       userlxn
// @match        https://jwgl.sdju.edu.cn/course-selection/*
// @grant        none
// @run-at       document-start
// @supportURL   https://github.com/userlxn/tampermonkey-scripts/tree/main/SDJU%E6%95%99%E5%8A%A1%E7%B3%BB%E7%BB%9F%E8%87%AA%E5%8A%A8%E6%8A%A2%E8%AF%BE/issues
// @homepageURL  https://greasyfork.org/zh-CN/scripts/595972-sdju%E6%95%99%E5%8A%A1%E8%87%AA%E5%8A%A8%E6%8A%A2%E8%AF%BE
// @downloadURL  https://update.greasyfork.org/scripts/595972/SDJU%E6%95%99%E5%8A%A1%E8%87%AA%E5%8A%A8%E6%8A%A2%E8%AF%BE.user.js
// @updateURL    https://update.greasyfork.org/scripts/595972/SDJU%E6%95%99%E5%8A%A1%E8%87%AA%E5%8A%A8%E6%8A%A2%E8%AF%BE.user.js
// ==/UserScript==

// 原版参考（老版正方系统，DOM 结构不同，本版已重写适配层）: https://github.com/ceilf6/Auto_courseGrabber
// 使用方法:
// 1. 安装 Tampermonkey 扩展，导入本脚本
// 2. 从教务首页正常登录并进入选课页面（https://jwgl.sdju.edu.cn/course-selection/...）
// 3. 页面加载后右上角自动弹出抢课控制面板
// 4. 在面板中添加目标课程（课程号或课程名称，如 053012R1 或 党史）
// 5. 点击「开始抢课」立即开抢，或设置「定时开抢」到点自动开抢
// 注意: 抢课时浏览器标签页需保持打开状态（可以切到后台，但不要关掉）

(function () {
    'use strict';

    // ========= 防止重复注入 =========
    if (window.__SDJU_GRABBER_LOADED__) {
        try {
            if (window.grab && typeof window.grab.stop === 'function') {
                window.grab.stop();
            }
        } catch (e) { /* 忽略 */ }
        console.warn('[抢课脚本] 检测到脚本已加载过一次，已停止旧实例并覆盖为新实例。');
    }
    window.__SDJU_GRABBER_LOADED__ = true;

    // ========== 网络拦截（document-start 立即生效：捕获课表数据 + 记录请求供诊断） ==========
    (function installNetworkHooks() {
        // 最近请求记录（点击诊断用）
        window.__recentRequests__ = [];
        function recordRequest(url) {
            const list = window.__recentRequests__ || (window.__recentRequests__ = []);
            list.push({ url: String(url), at: Date.now() });
            if (list.length > 50) list.shift();
        }

        function handleResponseBody(body, url) {
            if (!body || typeof body !== 'string' || body.length < 50) return;
            // 只关心疑似课表数据：含「星期/节」时间特征 + 课程特征
            if (!/星期|第\d+节|weekday|period/i.test(body)) return;
            if (!/course|lesson|kcmc|课程|name|title/i.test(body)) return;
            let parsed = null;
            try { parsed = JSON.parse(body); } catch (e) { return; }
            const captured = { url: String(url), data: parsed, at: Date.now() };
            window.__timetableRawData__ = captured;
            try {
                sessionStorage.setItem('sdju_timetable_raw', JSON.stringify(captured).slice(0, 300000));
            } catch (e) { /* 忽略存储失败 */ }
        }

        // hook fetch（保持透明转发，不影响页面功能）
        const origFetch = window.fetch;
        if (origFetch) {
            window.fetch = function (...args) {
                try { recordRequest(args[0]); } catch (e) { /* 忽略 */ }
                return origFetch.apply(this, args).then(res => {
                    try {
                        res.clone().text().then(t => handleResponseBody(t, args[0]));
                    } catch (e) { /* 忽略 */ }
                    return res;
                });
            };
        }
        // hook XMLHttpRequest（环境无 XHR 时跳过）
        if (typeof XMLHttpRequest !== 'undefined') {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this.__timetableHookUrl = String(url);
                try { recordRequest(url); } catch (e) { /* 忽略 */ }
                return origOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.send = function (...args) {
                if (!this.__timetableHookDone) {
                    this.__timetableHookDone = true;
                    this.addEventListener('load', () => {
                        try { handleResponseBody(this.responseText, this.__timetableHookUrl); } catch (e) { /* 忽略 */ }
                    });
                }
                return origSend.apply(this, args);
            };
            // hook setRequestHeader：记录页面自己设置的所有请求头（窃取页面 axios 的认证头）
            if (XMLHttpRequest.prototype.setRequestHeader) {
                const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
                XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                    try {
                        const h = window.__pageHeaders__ || (window.__pageHeaders__ = {});
                        h[name] = String(value);
                    } catch (e) { /* 忽略 */ }
                    return origSetHeader.call(this, name, value);
                };
            }
        }
    })();

    // ========== 配置参数 ==========
    // 目标课程列表（也可在 UI 面板中添加）
    // 格式: { code: '课程号或课程名称', priority: 优先级(数字越小越优先), timeFilter: [时间关键词], teacherFilter: [教师关键词] }
    // 课程号支持字母（如 053012R1），名称支持模糊匹配
    const TARGET_COURSES = [
        // 示例（抢课前替换成你的目标课程）:
        // { code: '053012R1', priority: 1 },                        // 用课程号
        // { code: '大学体育', priority: 2, timeFilter: ['星期三'] },  // 只要星期三的课
        // { code: '机器学习', priority: 3, teacherFilter: ['张三'] }  // 只要张三的课
    ];

    // ========== 速度档位（面板可选） ==========
    // 极速: 极限抢课（约0.5秒/课）；快速: 1秒内；标准: 均衡；保守: 防服务端限流
    const SPEED_PROFILES = {
        turbo:  { label: '🔥极速', checkInterval: 150,  clickCooldown: 500,  dialogPoll: 20,  postCloseDelay: 100, refreshEvery: 15 },
        fast:   { label: '⚡快速', checkInterval: 300,  clickCooldown: 1000, dialogPoll: 30,  postCloseDelay: 150, refreshEvery: 10 },
        normal: { label: '🚀标准', checkInterval: 1000, clickCooldown: 3000, dialogPoll: 50,  postCloseDelay: 400, refreshEvery: 5 },
        safe:   { label: '🐢保守', checkInterval: 2000, clickCooldown: 5000, dialogPoll: 100, postCloseDelay: 600, refreshEvery: 3 }
    };
    let SPEED_LEVEL = 'normal';           // 当前速度档位（面板可改）
    const speedCfg = () => SPEED_PROFILES[SPEED_LEVEL] || SPEED_PROFILES.normal;

    const MAX_FAILED_ATTEMPTS = 30;       // 单门课最大连续失败次数
    const DIALOG_TIMEOUT = 8000;          // 等待弹窗超时(毫秒)
    const CONCURRENT_ENABLED = true;      // 多门课程并发抢
    let endTime = null;                   // 自动停止时间（可选；null=持续抢课直到全部抢好或手动停止）

    // 校区筛选: '不限' | '闵行校区' | '临港校区'（默认临港校区，排除跨校区教学班）
    // 面板中可随时修改；只对列表选课视图有效（培养方案行没有校区信息，不做筛选）
    let GLOBAL_CAMPUS_FILTER = '临港校区';

    // 课表冲突预检配置
    const CONFLICT_PRECHECK_ENABLED = true;   // 是否启用课表冲突预检（点击前先比对课表，避免点完才提示冲突）
    const TIMETABLE_STORAGE_KEY = 'sdju_course_timetable_v1'; // 课表数据 localStorage 键名

    // 网课配置（网课=课程名带「智慧树:」或「尔雅:」前缀的课程）
    let ONLINE_TARGET_CREDITS = 6;            // 网课目标学分（默认6，面板可设置；选够自动停止网课抢课）
    let selectedOnlineCredits = 0;            // 已选网课学分（启动扫描基线 + 抢课成功累加）
    let ONLINE_PLATFORM_FILTER = 'all';       // 网课平台筛选: 'all' 都选 | '智慧树' 只选智慧树 | '尔雅' 只选尔雅

    // API 直选模式（直接调用选课接口，绕过页面弹窗——培养方案视图点击后前端静默无反馈）
    const API_DIRECT_ENABLED = true;
    const API_BASE = '/course-selection-api/api/v1/student/course-select';

    // ========== 全局状态 ==========
    let isRunning = false;
    let intervalId = null;
    let attemptCount = 0;
    let busy = false;                     // 正在处理一次选课点击（等弹窗期间不再触发新点击）

    let courseStates = new Map();         // 课程状态: {attempts, failed, tried, conflicted, selecting, success}
    let selectedCourses = new Set();
    let activeCourses = new Set();

    // 定时开抢
    let scheduledTime = null;
    let schedulerIntervalId = null;

    // ========== 工具函数 ==========

    function log(message, type = 'info', courseCode = null) {
        const timestamp = new Date().toLocaleTimeString();
        const courseTag = courseCode ? `[${courseCode}]` : '';
        const prefix = `[抢课脚本 ${timestamp}]${courseTag}`;
        switch (type) {
            case 'success': console.log(`%c${prefix} ✅ ${message}`, 'color: #00ff00; font-weight: bold;'); break;
            case 'error':   console.log(`%c${prefix} ❌ ${message}`, 'color: #ff0000; font-weight: bold;'); break;
            case 'warning': console.log(`%c${prefix} ⚠️ ${message}`, 'color: #ffa500; font-weight: bold;'); break;
            default:        console.log(`%c${prefix} ℹ️ ${message}`, 'color: #0099ff;'); break;
        }
    }

    function safeParseFilterInput(input, separatorRegex = /[，,;；]+/) {
        if (!input || typeof input !== 'string') return [];
        const raw = input.trim();
        if (!raw) return [];
        const parts = raw.split(separatorRegex);
        const result = [];
        for (let p of parts) {
            const v = String(p).trim();
            if (v) result.push(v);
        }
        return result;
    }

    function initCourseState(courseCode) {
        if (!courseStates.has(courseCode)) {
            courseStates.set(courseCode, {
                attempts: 0,
                failed: 0,
                tried: new Set(),
                conflicted: new Set(),
                selecting: false,
                success: false,
                lastResult: ''
            });
        }
        return courseStates.get(courseCode);
    }

    function getCourseState(courseCode) {
        return courseStates.get(courseCode) || initCourseState(courseCode);
    }

    // 判断元素是否可见（用于过滤隐藏视图里的残留行）
    function isVisible(el) {
        if (!el) return false;
        return el.offsetParent !== null || el.getClientRects().length > 0;
    }

    /** 页面上是否存在「操作太过频繁」消息框（防频繁窗口未过） */
    function hasFrequentMessageBox() {
        const boxes = document.querySelectorAll('.el-message-box__message');
        for (const box of boxes) {
            if (!isVisible(box)) continue;
            if (box.textContent.includes('频繁')) return box.closest('.el-message-box');
        }
        return null;
    }

    /** 关闭「操作太过频繁」消息框（点确定按钮） */
    function closeFrequentMessageBox(box) {
        if (!box) return false;
        const btns = box.querySelectorAll('.el-message-box__btns button');
        for (const btn of btns) {
            const text = btn.textContent.replace(/\s+/g, '').trim();
            if (text === '确定' || text === 'OK') {
                btn.click();
                return true;
            }
        }
        return false;
    }

    // ========== DOM 结构适配层（上海电机学院新版 EAMS 选课模块） ==========

    /**
     * 获取当前可见视图的所有课程行
     * 兼容两个视图:
     *   1. 列表选课视图: tr.el-table__row（Element UI 表格行）
     *   2. 培养方案视图: table#plan-courses-table tbody tr（排除模块分组行 tr.exclude-search）
     * 只返回含「选课」按钮且当前可见的行
     */
    function getAllCourseRows() {
        const rows = [];
        const seen = new Set();

        // 列表选课视图
        document.querySelectorAll('tr.el-table__row').forEach(row => {
            if (seen.has(row)) return;
            seen.add(row);
            rows.push(row);
        });

        // 培养方案视图
        document.querySelectorAll('#plan-courses-table tbody tr').forEach(row => {
            if (seen.has(row)) return;
            seen.add(row);
            if (row.classList.contains('exclude-search')) return; // 模块分组标题行
            rows.push(row);
        });

        // 过滤：必须有「选课」按钮且可见
        return rows.filter(row => {
            if (!row.querySelector('button.course-select')) return false;
            return isVisible(row);
        });
    }

    /**
     * 从行中提取课程信息
     * 统一两种视图的结构差异
     */
    function extractRowInfo(row) {
        const info = {
            row: row,
            courseName: '',
            courseCode: '',
            status: '',
            teacher: '',
            timeInfo: '',
            capacity: '',
            className: '',
            selectBtn: null,
            rawText: (row.textContent || '').replace(/\s+/g, ' ').trim()
        };

        // 课程名（两个视图都有 .course-name）
        const nameEl = row.querySelector('.course-name');
        if (nameEl) info.courseName = nameEl.textContent.trim();

        // 课程号：优先从教学班代码提取（如 (2026-2027-1)-053012R1-01 → 053012R1）
        // 兜底：课程信息区形如「数字+字母」的代码（如 053012R1、CS101）
        const lessonCodeEl = row.querySelector('.lesson-code');
        if (lessonCodeEl) {
            const m = lessonCodeEl.textContent.match(/\)-\s*([A-Za-z0-9]+)-\d+\s*$/);
            if (m) info.courseCode = m[1];
        }
        if (!info.courseCode) {
            const codeMatch = info.rawText.match(/\b\d{3,}[A-Za-z]+\d*\b/);
            if (codeMatch) info.courseCode = codeMatch[0];
        }

        // 选课状态标签（.select-label，如「待选课」）
        const statusEl = row.querySelector('.select-label');
        if (statusEl) info.status = statusEl.textContent.trim();

        // 教学班（列表选课视图）
        // 注意：行内同时存在正常显示层(.normal-*)和 tooltip 隐藏层(.tooltip-*)，
        // 外层容器(.lesson-name)在文档顺序中先于内层(.normal-lesson-name)，
        // 必须先单独查内层、再查外层，否则 textContent 会包含两层导致文本重复
        const lessonNameEl = row.querySelector('.normal-lesson-name') || row.querySelector('.lesson-name');
        if (lessonNameEl) info.className = lessonNameEl.textContent.trim();
        if (lessonCodeEl) info.className += (info.className ? ' ' : '') + lessonCodeEl.textContent.trim();

        // 教师（列表选课视图 .course-teacher；培养方案视图第6列）
        const teacherEl = row.querySelector('.normal-teachers') || row.querySelector('.course-teacher, .teachers');
        if (teacherEl) {
            info.teacher = teacherEl.textContent.replace(/\s+/g, ' ').trim();
        } else {
            // 培养方案视图：取「授课教师」列（第6个td，未配教学班时为空）
            const tds = row.querySelectorAll('td');
            if (tds.length >= 6) info.teacher = tds[5].textContent.replace(/\s+/g, ' ').trim();
        }

        // 时间地点（列表选课视图 .dateTimePlace；培养方案视图第7列）
        const timeEl = row.querySelector('.normal-dateTimePlace') || row.querySelector('.dateTimePlace');
        if (timeEl) {
            info.timeInfo = timeEl.textContent.replace(/\s+/g, ' ').trim();
        } else {
            const tds = row.querySelectorAll('td');
            if (tds.length >= 7) info.timeInfo = tds[6].textContent.replace(/\s+/g, ' ').trim();
        }

        // 已选/人数上限（列表选课视图 .not-show-count，如「未满」/「已满」）
        const capEl = row.querySelector('.not-show-count');
        if (capEl) info.capacity = capEl.textContent.replace(/\s+/g, ' ').trim();

        // 校区（从时间地点文本提取）
        info.campus = extractCampus(info.timeInfo);

        // 学分（课程信息区如「2学分」）
        const creditMatch = info.rawText.match(/(\d+(?:\.\d+)?)\s*学分/);
        info.credit = creditMatch ? parseFloat(creditMatch[1]) : 0;

        // 选课按钮
        info.selectBtn = row.querySelector('button.course-select');

        return info;
    }

    // ========== 课表数据与时间解析（冲突预检） ==========

    function range(a, b) {
        const r = [];
        for (let i = a; i <= b; i++) r.push(i);
        return r;
    }

    /**
     * 解析时间地点文本，如「2-8周 星期三 5-6节 闵行校区 一教102」
     * 支持：全学期(1-16周)、半学期(2-8周/9-16周)、单双周、多个时间段(分号分隔)
     * @returns {Array<{day, periods, weeks, oddEven, raw}>} 时间段数组（无法解析返回空数组）
     */
    function parseTimeSlots(timeText) {
        if (!timeText || timeText === '未知时间') return [];
        const slots = [];
        const parts = String(timeText).split(/[;；\n]+/);
        for (const part of parts) {
            const p = part.trim();
            if (!p) continue;

            // 周次范围: 「2-8周」「第1-16周」
            let weeks = [];
            const weekMatch = p.match(/(?:第)?(\d+)\s*[-—~至]\s*(\d+)\s*周/);
            if (weekMatch) weeks = range(parseInt(weekMatch[1]), parseInt(weekMatch[2]));
            // 单个周次: 「3周」
            if (weeks.length === 0) {
                const singleWeek = p.match(/(?:第)?(\d+)\s*周(?![-—~至])/);
                if (singleWeek) weeks = [parseInt(singleWeek[1])];
            }

            // 单双周模式
            let oddEven = 'all';
            if (/单周|\(单\)|（单）/.test(p)) oddEven = 'odd';
            else if (/双周|\(双\)|（双）/.test(p)) oddEven = 'even';

            // 星期
            let day = 0;
            const dayMatch = p.match(/星期([一二三四五六日天])/);
            if (dayMatch) day = '一二三四五六日天'.indexOf(dayMatch[1]) + 1;

            // 节次: 「5-6节」「第5-6节」或单节「3节」
            let periods = [];
            const periodMatch = p.match(/(?:第)?(\d+)\s*[-—~至]\s*(\d+)\s*节/);
            if (periodMatch) {
                periods = range(parseInt(periodMatch[1]), parseInt(periodMatch[2]));
            } else {
                const singlePeriod = p.match(/(?:第)?(\d+)\s*节/);
                if (singlePeriod) periods = [parseInt(singlePeriod[1])];
            }

            // 解析出「星期+节次」即认为有效；周次缺失按全学期(1-20周)处理
            if (day && periods.length > 0) {
                if (weeks.length === 0) weeks = range(1, 20);
                slots.push({ day, periods, weeks, oddEven, raw: p });
            }
        }
        return slots;
    }

    /** 判定两个时间槽是否冲突（星期相同 + 节次有交集 + 实际周次有交集） */
    function slotsConflict(a, b) {
        if (a.day !== b.day) return false;
        if (!a.periods.some(p => b.periods.includes(p))) return false;
        // 按单双周过滤出实际周集合
        const aWeeks = a.weeks.filter(w => a.oddEven === 'all' ? true : (a.oddEven === 'odd' ? w % 2 === 1 : w % 2 === 0));
        const bWeeks = b.weeks.filter(w => b.oddEven === 'all' ? true : (b.oddEven === 'odd' ? w % 2 === 1 : w % 2 === 0));
        return aWeeks.some(w => bWeeks.includes(w));
    }

    /**
     * 读取本地课表数据
     * 格式: [{name: '课程名', slots: [{day, periods, weeks, oddEven}]}, ...]
     */
    function loadTimetable() {
        try {
            const raw = localStorage.getItem(TIMETABLE_STORAGE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!Array.isArray(data)) return null;
            return data;
        } catch (e) {
            return null;
        }
    }

    /** 保存课表数据到本地 */
    function saveTimetable(data) {
        try {
            localStorage.setItem(TIMETABLE_STORAGE_KEY, JSON.stringify(data));
            return true;
        } catch (e) {
            log(`保存课表数据失败: ${e.message}`, 'error');
            return false;
        }
    }

    /** 课表状态描述（用于 UI 提示，统计导入数据 + 运行时扫描数据） */
    function getTimetableStatus() {
        const tt = getEffectiveTimetable();
        if (!tt || tt.length === 0) return { loaded: false, count: 0, text: '未导入' };
        const slotCount = tt.reduce((sum, entry) => sum + (entry.slots ? entry.slots.length : 0), 0);
        return { loaded: true, count: tt.length, text: `已导入 ${tt.length} 门课 (${slotCount} 个时间段)` };
    }

    /** 检查教学班时间与课表是否冲突（预检） */
    function checkTimetableConflict(timeInfo) {
        if (!CONFLICT_PRECHECK_ENABLED) return { known: false, conflict: false, reason: '预检未启用' };
        const timetable = getEffectiveTimetable();
        if (!timetable || timetable.length === 0) {
            return { known: false, conflict: false, reason: '课表数据未导入' };
        }
        const slots = parseTimeSlots(timeInfo);
        if (slots.length === 0) {
            return { known: true, conflict: false, reason: '时间格式无法解析，跳过预检' };
        }
        const currentSem = getCurrentSemester();
        for (const slot of slots) {
            for (const entry of timetable) {
                if (!entry.slots) continue;
                // 学期过滤：只比对当前学期的课表（防止上学期数据误杀教学班）
                if (currentSem && entry.semester && entry.semester !== currentSem) continue;
                for (const entrySlot of entry.slots) {
                    if (slotsConflict(slot, entrySlot)) {
                        return { known: true, conflict: true, reason: `与课表「${entry.name}」冲突` };
                    }
                }
            }
        }
        return { known: true, conflict: false, reason: '' };
    }

    /**
     * 从网络拦截捕获的课表接口数据导入课表（兜底方案）
     * 流程：解析捕获数据 → 按当前学期过滤 → 保存；解析失败则导出原始 JSON 供适配
     */
    function importCapturedTimetable() {
        const raw = window.__timetableRawData__;
        if (!raw) {
            alert('尚未捕获到课表接口数据。\n\n（当前版本主要在选课页面运行，课表数据以「已选课程」扫描为主。）');
            log('未捕获到课表接口数据', 'warning');
            return false;
        }
        const parsed = tryParseTimetableData(raw.data);
        if (parsed && parsed.length > 0) {
            const semSet = [...new Set(parsed.map(e => e.semester).filter(Boolean))];
            const currentSem = getCurrentSemester();
            // 只导入当前学期数据（防止上学期课表误杀教学班）
            const matching = parsed.filter(e => !e.semester || !currentSem || e.semester === currentSem);
            if (matching.length > 0) {
                if (saveTimetable(matching)) {
                    const semText = semSet.length ? `（学期: ${semSet.join(', ')}）` : '';
                    log(`✅ 已解析课表: ${matching.length} 门课 ${semText}`, 'success');
                    alert(`课表导入成功！\n\n已识别 ${matching.length} 门课程的时间安排${semText}，冲突预检已启用。`);
                    updateTimetableStatus();
                    return true;
                }
            } else {
                alert(`课表数据中没有当前学期（${currentSem || '未知'}）的排课。\n\n可能原因：本学期尚未开学，课表还没生成。`);
                log(`课表数据学期与当前学期不符（数据学期: ${semSet.join(',') || '未知'}），不导入`, 'warning');
                return false;
            }
        }
        alert('课表接口数据格式无法解析。');
        log('课表数据格式未识别', 'warning');
        return false;
    }

    /**
     * 精确解析 SDJU 课表接口数据
     * 结构: data.studentTableVms[].activities[]
     * 字段: courseName / weekday(1-7) / startUnit / endUnit / weekIndexes(实际周次数组，单双周已过滤) / lessonCode(含学期)
     * 返回 [{name, semester, slots: [{day, periods, weeks, oddEven}]}]；解析不出返回 []
     */
    function tryParseTimetableData(data) {
        const entriesMap = new Map(); // courseName -> {name, semester, slots}
        const vms = data && data.studentTableVms;
        if (!Array.isArray(vms)) return [];
        for (const vm of vms) {
            if (!vm || !Array.isArray(vm.activities)) continue;
            for (const act of vm.activities) {
                const name = act.courseName ? String(act.courseName).replace(/\s+/g, ' ').trim() : '';
                const day = parseInt(act.weekday);
                const sp = parseInt(act.startUnit);
                const ep = parseInt(act.endUnit);
                const weeks = Array.isArray(act.weekIndexes)
                    ? act.weekIndexes.map(Number).filter(w => !isNaN(w) && w > 0)
                    : [];
                if (!name || isNaN(day) || isNaN(sp) || weeks.length === 0) continue;
                const periods = isNaN(ep) ? [sp] : range(sp, ep);
                // 学期: lessonCode 形如 "(2026-2027-1)-053017P1-13"
                const semMatch = String(act.lessonCode || '').match(/^\((\d{4}-\d{4}-\d)\)/);
                const semester = semMatch ? semMatch[1] : '';
                if (!entriesMap.has(name)) entriesMap.set(name, { name, semester, slots: [] });
                const entry = entriesMap.get(name);
                if (!entry.semester && semester) entry.semester = semester;
                entry.slots.push({ day, periods, weeks, oddEven: 'all' });
            }
        }
        return Array.from(entriesMap.values());
    }

    /** 从选课页标题提取当前学期，如「2026-2027学年第1学期」→ '2026-2027-1' */
    function getCurrentSemester() {
        const titleEl = document.querySelector('.course-select-semester');
        const text = titleEl ? titleEl.textContent : '';
        const m = text.match(/(\d{4})-(\d{4})学年第(\d)学期/);
        if (!m) return '';
        return `${m[1]}-${m[2]}-${m[3]}`;
    }

    /**
     * 从选课页「已选课程」表提取已选课程的时间安排（抢课时最直接的数据源）
     * 已选课程表: #selected-lesson .selected-table-wrap 的第6列「时间地点」
     * 时间地点文本如「2-8周 星期三 5-6节 闵行校区 一教102」，用 parseTimeSlots 解析
     */
    function scanSelectedLessonTimes() {
        const entries = [];
        const table = document.querySelector('#selected-lesson .selected-table-wrap');
        if (!table) return entries;
        const rows = table.querySelectorAll('tbody tr');
        for (const row of rows) {
            const nameEl = row.querySelector('.course-name');
            const name = nameEl ? nameEl.textContent.trim() : '';
            if (!name) continue;
            // 时间地点列是第6个 td
            const tds = row.querySelectorAll('td');
            const timeText = tds.length >= 6 ? tds[5].textContent.replace(/\s+/g, ' ').trim() : '';
            if (!timeText || !timeText.includes('星期')) continue; // 无具体排课时间则跳过
            const slots = parseTimeSlots(timeText);
            if (slots.length > 0) {
                entries.push({ name, semester: getCurrentSemester(), slots });
            }
        }
        return entries;
    }

    // 运行时课表数据：启动抢课时从「已选课程」表扫描得到（比 localStorage 导入更及时）
    let runtimeSelectedLessonEntries = [];

    /** 手动扫描「已选课程」时间（冲突预检数据源；学校排课后才有数据） */
    function rescanSelectedLessonTimes() {
        runtimeSelectedLessonEntries = scanSelectedLessonTimes();
        if (runtimeSelectedLessonEntries.length > 0) {
            log(`✅ 已从「已选课程」扫描 ${runtimeSelectedLessonEntries.length} 门课的时间，冲突预检生效`, 'success');
            alert(`扫描完成！\n\n已识别 ${runtimeSelectedLessonEntries.length} 门已选课程的时间安排，冲突预检已生效。`);
            updateTimetableStatus();
            return true;
        }
        log('「已选课程」中暂无排课时间（可能尚未排课）', 'warning');
        alert('「已选课程」中暂无排课时间信息。\n\n可能原因：学校尚未完成排课（开学前常见）。\n排课完成后点此按钮更新；开始抢课时也会自动扫描。');
        return false;
    }

    /** 冲突预检使用的完整课表数据 = 导入的课表数据 + 运行时扫描的已选课程时间 */
    function getEffectiveTimetable() {
        const stored = loadTimetable() || [];
        return stored.concat(runtimeSelectedLessonEntries);
    }


    /** 更新 UI 中课表状态提示 */
    function updateTimetableStatus() {
        const el = document.getElementById('sg-timetable-status');
        if (!el) return;
        const st = getTimetableStatus();
        if (st.loaded) {
            el.textContent = `课表数据：${st.text} ✅ 冲突预检已启用`;
        } else {
            el.textContent = '课表数据：未导入 ⚠️ 冲突预检未启用（到首页「我的课表」点读取课表）';
        }
    }

    // ========== 网课识别（智慧树/尔雅） ==========

    /**
     * 解析网课课程名，如「智慧树:大学美育」「尔雅:《音乐鉴赏》」
     * @returns {{platform, realName}|null} 非网课返回 null
     */
    function parseOnlineCourse(name) {
        const m = String(name || '').trim().match(/^(智慧树|尔雅)\s*[:：]\s*(.+)$/);
        if (!m) return null;
        return { platform: m[1], realName: m[2].trim() };
    }

    /** 扫描页面中所有网课（按课程名去重），返回课程信息数组 */
    function scanOnlineCourses() {
        const map = new Map(); // courseName -> {name, platform, credit, courseCode}
        for (const row of getAllCourseRows()) {
            const info = extractRowInfo(row);
            const parsed = parseOnlineCourse(info.courseName);
            if (!parsed) continue;
            const key = info.courseName;
            if (map.has(key)) {
                // 补学分（培养方案行有学分、列表行可能没有）
                if (info.credit && !map.get(key).credit) map.get(key).credit = info.credit;
                if (info.courseCode && !map.get(key).courseCode) map.get(key).courseCode = info.courseCode;
                continue;
            }
            map.set(key, {
                name: info.courseName,
                platform: parsed.platform,
                realName: parsed.realName,
                credit: info.credit || 0,
                courseCode: info.courseCode || ''
            });
        }
        return Array.from(map.values());
    }

    /** 一键添加所有网课到目标列表（智慧树优先、同平台学分高优先；支持平台筛选） */
    function addAllOnlineCourses() {
        let courses = scanOnlineCourses();
        // 平台筛选
        if (ONLINE_PLATFORM_FILTER !== 'all') {
            courses = courses.filter(c => c.platform === ONLINE_PLATFORM_FILTER);
        }
        if (courses.length === 0) {
            alert('未在页面中找到网课\n\n（课程名带「智慧树:」或「尔雅:」前缀的课程）\n请确认当前在选课页面且课程列表已加载，或检查平台筛选设置。');
            return 0;
        }
        // 排序：智慧树优先；同平台学分高优先
        courses.sort((a, b) => {
            if (a.platform !== b.platform) return a.platform === '智慧树' ? -1 : 1;
            return (b.credit || 0) - (a.credit || 0);
        });
        const existing = new Set(TARGET_COURSES.map(c => c.code));
        let added = 0;
        courses.forEach((c, i) => {
            if (existing.has(c.name)) return;
            TARGET_COURSES.push({
                code: c.name, // 用完整课程名（含平台前缀）作为匹配键
                priority: c.platform === '智慧树' ? i + 1 : 100 + i, // 智慧树整体优先于尔雅
                credit: c.credit,
                isOnline: true,
                platform: c.platform
            });
            existing.add(c.name);
            added++;
        });
        if (added > 0) {
            updateCourseList();
            const zs = courses.filter(c => c.platform === '智慧树').length;
            const ey = courses.filter(c => c.platform === '尔雅').length;
            log(`✅ 已添加 ${added} 门网课（智慧树 ${zs} 门 + 尔雅 ${ey} 门，智慧树优先、学分高优先）`, 'success');
            addUILog('success', `一键添加 ${added} 门网课（智慧树 ${zs} + 尔雅 ${ey}）`);
        }
        return added;
    }

    /** 扫描「已选课程」tab 中已选网课的学分合计 */
    function scanSelectedOnlineCredits() {
        let total = 0;
        const table = document.querySelector('#selected-lesson .selected-table-wrap');
        if (!table) return 0;
        const rows = table.querySelectorAll('tbody tr');
        for (const row of rows) {
            const text = (row.textContent || '').replace(/\s+/g, ' ');
            if (text.includes('智慧树') || text.includes('尔雅')) {
                const cm = text.match(/(\d+(?:\.\d+)?)\s*学分/);
                if (cm) total += parseFloat(cm[1]);
            }
        }
        return total;
    }

    /** 停止所有网课目标（选够学分后调用） */
    function stopOnlineCourses() {
        let removed = 0;
        for (const code of Array.from(activeCourses)) {
            const cfg = TARGET_COURSES.find(c => c.code === code);
            if (cfg && cfg.isOnline) {
                activeCourses.delete(code);
                removed++;
            }
        }
        log(`🎉 网课学分已达目标 ${ONLINE_TARGET_CREDITS}，已移除剩余 ${removed} 门网课目标`, 'success');
        addUILog('success', `网课选够 ${ONLINE_TARGET_CREDITS} 学分，自动停止网课抢课`);
        try {
            if (window.Notification && Notification.permission === 'granted') {
                new Notification('网课选课完成！', { body: `已选够 ${selectedOnlineCredits} 学分网课` });
            }
        } catch (e) { /* 忽略 */ }
        if (activeCourses.size === 0) stopGrabbing();
    }

    // ========== 校区筛选 ==========

    /** 从行信息提取校区（时间地点文本中的校区关键词） */
    function extractCampus(timeInfo) {
        if (!timeInfo) return '';
        if (timeInfo.includes('闵行校区')) return '闵行校区';
        if (timeInfo.includes('临港校区')) return '临港校区';
        return '';
    }

    /** 校区筛选匹配：无校区信息的行（培养方案视图）不筛 */
    function matchesCampusFilter(campus, filter) {
        if (!filter || filter === '不限') return true;
        if (!campus) return true;
        return campus === filter;
    }

    /** 判断行是否匹配目标课程（课程号/名称包含匹配，不区分大小写） */
    function isRowMatchingCourse(info, targetCode) {
        const input = String(targetCode).trim().toLowerCase();
        if (!input) return false;
        if (info.courseName.toLowerCase().includes(input)) return true;
        if (info.courseCode.toLowerCase().includes(input)) return true;
        // 兜底：整个行文本包含
        if (info.rawText.toLowerCase().includes(input)) return true;
        return false;
    }

    /** 查找目标课程在当前视图中的所有匹配行 */
    function findAllRowsForCourse(targetCode) {
        const result = [];
        for (const row of getAllCourseRows()) {
            const info = extractRowInfo(row);
            if (isRowMatchingCourse(info, targetCode)) {
                result.push(info);
            }
        }
        return result;
    }

    // 时间过滤匹配
    function matchesTimeFilter(timeInfo, timeFilter) {
        if (!timeFilter || timeFilter.length === 0) return true;
        if (!timeInfo || timeInfo === '未知时间') return false;
        for (const kw of timeFilter) {
            if (timeInfo.includes(kw)) return true;
        }
        return false;
    }

    // 教师过滤匹配
    function matchesTeacherFilter(teacher, teacherFilter) {
        if (!teacherFilter || teacherFilter.length === 0) return true;
        if (!teacher || teacher === '未知教师') return false;
        for (const kw of teacherFilter) {
            if (teacher.includes(kw)) return true;
        }
        return false;
    }

    /** 检查行是否可抢 */
    function checkRowSelectable(info) {
        // 必须有选课按钮
        if (!info.selectBtn) return { ok: false, reason: '无选课按钮' };
        // 状态必须是「待选课」
        if (info.status && info.status !== '待选课') {
            return { ok: false, reason: `状态: ${info.status}` };
        }
        // 已满检查
        if (info.capacity && (info.capacity.includes('已满') || info.capacity.includes('满员'))) {
            return { ok: false, reason: '人数已满' };
        }
        return { ok: true, reason: '' };
    }

    // ========== API 直选（直接调用选课接口，绕过页面弹窗） ==========
    // 依据前端源码（chunk-410371a8.js 模块 365c）：
    //   提交: POST /api/v1/student/course-select/add-request
    //         body: {studentAssoc, courseSelectTurnAssoc, requestMiddleDtos:[{lessonAssoc, virtualCost, scheduleGroupAssoc}], coursePackAssoc}
    //   轮询: GET  /api/v1/student/course-select/add-drop-response/{studentId}/{requestId}
    //         data: {success, errorMessage{textZh/textEn}, resend}
    //   培养方案: GET /api/v1/student/course-select/major-plan/{turnId}/{studentId}

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    /** 从页面 URL 解析学生ID与选课轮次ID，如 #/course-select/88256/turn/664/select */
    function parseIdsFromUrl() {
        const m = window.location.hash.match(/course-select\/(\d+)\/turn\/(\d+)/);
        if (!m) return null;
        return { studentId: Number(m[1]), turnId: Number(m[2]) };
    }

    // 认证头缓存：优先窃取页面 axios 自己设置的头；401 时再探测常见格式
    let cachedAuthHeaders = null;

    /** 从页面请求中窃取认证类请求头（页面 axios 设置过的 token/auth/jwt 头） */
    function getPageAuthHeaders() {
        const pageHeaders = window.__pageHeaders__ || {};
        const out = {};
        for (const key of Object.keys(pageHeaders)) {
            if (/token|auth|jwt|credential/i.test(key)) {
                out[key] = pageHeaders[key];
            }
        }
        return Object.keys(out).length > 0 ? out : null;
    }

    /** 探测有效的认证头（token 来自 localStorage，头名逐个尝试） */
    async function probeAuthHeaders() {
        const token = (localStorage.getItem('cs-course-select-student-token') || '').trim();
        if (!token) return null;
        const candidates = [
            { 'Authorization': 'Bearer ' + token },
            { 'Authorization': token },
            { 'X-Token': token },
            { 'token': token },
            { 'X-Auth-Token': token }
        ];
        for (const headers of candidates) {
            try {
                const res = await fetch(API_BASE + '/students', { credentials: 'include', headers });
                if (res.ok) {
                    const name = Object.keys(headers)[0];
                    log(`🔑 认证头探测成功: ${name}`, 'success');
                    return headers;
                }
            } catch (e) { /* 试下一个 */ }
        }
        return null;
    }

    /** 同源 API 请求（带 cookie + 页面窃取头/探测头） */
    async function apiFetch(path, options = {}) {
        const headers = Object.assign({}, options.headers);
        if (cachedAuthHeaders) {
            Object.assign(headers, cachedAuthHeaders);
        } else {
            // 优先使用页面 axios 设置过的认证头（确定性最高）
            const pageAuth = getPageAuthHeaders();
            if (pageAuth) {
                cachedAuthHeaders = pageAuth;
                Object.assign(headers, cachedAuthHeaders);
                log('🔑 已从页面请求中获取认证头: ' + Object.keys(pageAuth).join(', '), 'success');
            }
        }
        let res = await fetch(API_BASE + path, Object.assign({ credentials: 'include' }, options, { headers }));
        if (res.status === 401 && !cachedAuthHeaders) {
            // 无认证头且被拒：探测常见格式后重试一次
            cachedAuthHeaders = await probeAuthHeaders();
            if (cachedAuthHeaders) {
                Object.assign(headers, cachedAuthHeaders);
                res = await fetch(API_BASE + path, Object.assign({ credentials: 'include' }, options, { headers }));
            }
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    let majorPlanCache = null;

    /** 获取培养方案数据（含每门课的 lessonAssoc id） */
    async function getMajorPlan(force = false) {
        const ids = parseIdsFromUrl();
        if (!ids) return null;
        if (!force && majorPlanCache) return majorPlanCache;
        try {
            const res = await apiFetch(`/major-plan/${ids.turnId}/${ids.studentId}`);
            majorPlanCache = res;
            return res;
        } catch (e) {
            log(`获取培养方案接口失败: ${e.message}`, 'warning');
            return null;
        }
    }

    /** 在培养方案数据中递归查找目标课程（按课程名包含匹配），返回含 id 的课程对象 */
    function findLessonInPlan(node, courseCode) {
        if (!node || typeof node !== 'object') return null;
        const input = String(courseCode).trim();
        if (node.id !== undefined && typeof node.id === 'number') {
            const name = node.courseName || node.name || node.course || '';
            if (String(name).includes(input) || input.includes(String(name))) {
                return node;
            }
        }
        // 递归子节点（数组或对象）
        if (Array.isArray(node)) {
            for (const item of node) {
                const found = findLessonInPlan(item, courseCode);
                if (found) return found;
            }
        } else {
            for (const key of Object.keys(node)) {
                if (key === 'children' || key === 'lessons' || key === 'courses' || key === 'items' || typeof node[key] === 'object') {
                    const found = findLessonInPlan(node[key], courseCode);
                    if (found) return found;
                }
            }
        }
        return null;
    }

    /**
     * API 直选一门课程：提交 add-request → 轮询 add-drop-response
     * @returns {{ok: boolean, type: string, text: string}} ok=接口路径可用；type 映射到结果类型
     */
    async function apiSelectCourse(courseCode) {
        const ids = parseIdsFromUrl();
        if (!ids) return { ok: false, type: 'unknown', text: '无法解析URL中的学生/轮次ID' };

        let plan = await getMajorPlan();
        let lesson = plan ? findLessonInPlan(plan, courseCode) : null;
        if (!lesson || lesson.id === undefined) {
            // 缓存可能过期，强制刷新一次
            plan = await getMajorPlan(true);
            lesson = plan ? findLessonInPlan(plan, courseCode) : null;
        }
        if (!lesson || lesson.id === undefined) {
            return { ok: false, type: 'unknown', text: '培养方案数据中未找到该课程' };
        }

        // 提交选课请求（与前端 addCourseRequest 相同格式）
        const scheduleGroupAssoc = (Array.isArray(lesson.scheduleGroups) && lesson.scheduleGroups.length === 1)
            ? lesson.scheduleGroups[0].id
            : null;
        const body = {
            studentAssoc: ids.studentId,
            courseSelectTurnAssoc: ids.turnId,
            requestMiddleDtos: [{
                lessonAssoc: lesson.id,
                virtualCost: '',
                scheduleGroupAssoc: scheduleGroupAssoc
            }],
            coursePackAssoc: null
        };

        try {
            const submitRes = await apiFetch('/add-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            // 防御式解析 requestId：data 可能是字符串（UUID 本身）或 {requestId} 对象
            const data = submitRes && submitRes.data;
            const requestId = data && (data.requestId !== undefined ? data.requestId :
                (typeof data === 'number' || typeof data === 'string' ? data : (submitRes && submitRes.requestId)));
            if (requestId === undefined || requestId === null || requestId === '') {
                return { ok: true, type: 'fail', text: '提交接口未返回请求ID（可能被拒绝）: ' + JSON.stringify(submitRes).slice(0, 120) };
            }
            // 轮询选课结果
            for (let i = 0; i < 40; i++) {
                if (!isRunning) return { ok: true, type: 'unknown', text: '脚本已停止' };
                await sleep(300);
                const poll = await apiFetch(`/add-drop-response/${ids.studentId}/${requestId}`);
                const d = poll && poll.data;
                if (!d) continue;
                if (d.success) {
                    return { ok: true, type: 'success', text: '选课成功' };
                }
                if (d.errorMessage) {
                    const msg = typeof d.errorMessage === 'string'
                        ? d.errorMessage
                        : (d.errorMessage.textZh || d.errorMessage.text || d.errorMessage.textEn || JSON.stringify(d.errorMessage).slice(0, 100));
                    return { ok: true, type: 'fail', text: String(msg) };
                }
                // 还在处理中，继续轮询
            }
            return { ok: true, type: 'unknown', text: '选课结果轮询超时' };
        } catch (e) {
            return { ok: true, type: 'fail', text: 'API直选异常: ' + e.message };
        }
    }

    /**
     * API 直退一门课程：POST drop-request → 轮询 add-drop-response
     * @returns {{ok: boolean, text: string}}
     */
    async function apiDropCourse(courseCode) {
        const ids = parseIdsFromUrl();
        if (!ids) return { ok: false, text: '无法解析URL中的学生/轮次ID' };
        const plan = await getMajorPlan(true);
        const lesson = plan ? findLessonInPlan(plan, courseCode) : null;
        if (!lesson || lesson.id === undefined) return { ok: false, text: '培养方案数据中未找到该课程' };
        const body = {
            studentAssoc: ids.studentId,
            courseSelectTurnAssoc: ids.turnId,
            requestMiddleDtos: [{
                lessonAssoc: lesson.id,
                virtualCost: '',
                scheduleGroupAssoc: null
            }],
            coursePackAssoc: null
        };
        try {
            const res = await apiFetch('/drop-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = res && res.data;
            const requestId = data && (data.requestId !== undefined ? data.requestId :
                (typeof data === 'number' || typeof data === 'string' ? data : (res && res.requestId)));
            if (!requestId) return { ok: true, text: '退课提交未返回请求ID: ' + JSON.stringify(res).slice(0, 100) };
            for (let i = 0; i < 40; i++) {
                await sleep(300);
                const poll = await apiFetch(`/add-drop-response/${ids.studentId}/${requestId}`);
                const d = poll && poll.data;
                if (!d) continue;
                if (d.success) return { ok: true, text: '退课成功' };
                if (d.errorMessage) {
                    const msg = typeof d.errorMessage === 'string' ? d.errorMessage : (d.errorMessage.textZh || d.errorMessage.text || d.errorMessage.textEn || '');
                    return { ok: true, text: '退课结果: ' + String(msg) };
                }
            }
            return { ok: true, text: '退课结果未知（轮询超时）' };
        } catch (e) {
            return { ok: true, text: '退课异常: ' + e.message };
        }
    }

    /** 扫描「已选课程」表中的网课课程名列表 */
    function scanSelectedOnlineCourseNames() {
        const names = [];
        const table = document.querySelector('#selected-lesson .selected-table-wrap');
        if (!table) return names;
        const rows = table.querySelectorAll('tbody tr');
        for (const row of rows) {
            const nameEl = row.querySelector('.course-name');
            const name = nameEl ? nameEl.textContent.trim() : '';
            if (name && parseOnlineCourse(name)) names.push(name);
        }
        return names;
    }

    /**
     * 批量退已选的网课（可选保留数量）
     * @param {string} platform 只退某平台: '' 全部 | '智慧树' | '尔雅'
     * @param {number} keepCount 保留前 N 门不退（按课程名排序），0=全退
     */
    async function dropOnlineCourses(platform = '', keepCount = 0) {
        let names = scanSelectedOnlineCourseNames();
        if (platform) names = names.filter(n => parseOnlineCourse(n).platform === platform);
        if (names.length === 0) return { ok: false, text: '未在「已选课程」中找到网课' };
        const toDrop = names.slice(keepCount);
        if (toDrop.length === 0) return { ok: true, text: `已选网课不超过 ${keepCount} 门，无需退课` };
        let success = 0;
        const results = [];
        for (const name of toDrop) {
            if (!isRunning) break;
            const r = await apiDropCourse(name);
            results.push(`${name}: ${r.text}`);
            if (r.ok && r.text === '退课成功') success++;
            log(`🔄 退课 ${name}: ${r.text}`, r.ok && r.text === '退课成功' ? 'success' : 'warning');
            await sleep(400);
        }
        log(`退课完成: 成功 ${success}/${toDrop.length}`, 'success');
        return { ok: true, text: `退课完成: 成功 ${success}/${toDrop.length}`, results };
    }

    // ========== 选课交互（点击 → 弹窗 → 结果解析 → 关闭） ==========

    /** 获取当前可见的「选课结果」弹窗 */
    function getVisibleResultDialog() {
        const wrappers = document.querySelectorAll('.el-dialog__wrapper');
        for (const w of wrappers) {
            if (w.style.display === 'none') continue;
            const dlg = w.querySelector('.el-dialog[aria-label="选课结果"]');
            if (dlg) return { wrapper: w, dialog: dlg };
        }
        return null;
    }

    /** 获取当前可见的「上课小组」弹窗 */
    function getVisibleGroupDialog() {
        const wrappers = document.querySelectorAll('.el-dialog__wrapper');
        for (const w of wrappers) {
            if (w.style.display === 'none') continue;
            const dlg = w.querySelector('.el-dialog[aria-label="上课小组"]');
            if (dlg) return { wrapper: w, dialog: dlg };
        }
        return null;
    }

    /** 判断加载弹窗是否正在显示 */
    function isLoadingDialogVisible() {
        const wrappers = document.querySelectorAll('.el-dialog__wrapper');
        for (const w of wrappers) {
            if (w.style.display === 'none') continue;
            if (w.querySelector('.loading__body')) return true;
        }
        return false;
    }

    /**
     * 获取当前可见的任意结果载体（兜底检测）：
     * 1. 任意可见 el-dialog（排除「正在加载」弹窗）
     * 2. el-message-box 消息框（$alert/$confirm 动态创建，如「您操作太过频繁」）
     * 3. PNotify 通知条（教务系统大量使用）
     * 4. Element UI message 消息条
     */
    function getVisibleAnyResult() {
        // 任意可见 el-dialog（排除加载弹窗）
        const wrappers = document.querySelectorAll('.el-dialog__wrapper');
        for (const w of wrappers) {
            if (w.style.display === 'none') continue;
            const dlg = w.querySelector('.el-dialog');
            if (!dlg) continue;
            if (dlg.querySelector('.loading__body')) continue; // 跳过「正在加载」
            const label = dlg.getAttribute('aria-label') || '';
            const titleEl = dlg.querySelector('.el-dialog__title');
            const title = titleEl ? titleEl.textContent.trim() : '';
            return { wrapper: w, dialog: dlg, kind: 'el-dialog', label, title };
        }
        // el-message-box 消息框（$alert/$confirm 动态创建在 body 下）
        const msgBox = document.querySelector('.el-message-box');
        if (msgBox && isVisible(msgBox)) {
            return { wrapper: msgBox, dialog: msgBox, kind: 'message-box', label: '消息框', title: '' };
        }
        // PNotify 通知条
        const pnotify = document.querySelector('.ui-pnotify');
        if (pnotify && isVisible(pnotify)) {
            return { wrapper: pnotify, dialog: pnotify, kind: 'pnotify', label: 'PNotify', title: '' };
        }
        // Element UI message
        const message = document.querySelector('.el-message');
        if (message && isVisible(message)) {
            return { wrapper: message, dialog: message, kind: 'el-message', label: 'el-message', title: '' };
        }
        return null;
    }

    /** 收集当前可见弹窗的标题列表（超时诊断用） */
    function collectVisibleDialogs() {
        const list = [];
        document.querySelectorAll('.el-dialog__wrapper').forEach(w => {
            if (w.style.display === 'none') return;
            const dlg = w.querySelector('.el-dialog');
            if (!dlg) return;
            const label = dlg.getAttribute('aria-label') || '';
            const titleEl = dlg.querySelector('.el-dialog__title');
            const title = titleEl ? titleEl.textContent.trim() : '';
            list.push(label || title || '(无标题弹窗)');
        });
        if (document.querySelector('.ui-pnotify')) list.push('PNotify通知条');
        if (document.querySelector('.el-message')) list.push('el-message消息条');
        if (document.querySelector('.el-message-box')) list.push('el-message-box消息框');
        return list;
    }

    /**
     * 轮询等待选课结果出现；期间自动处理「上课小组」弹窗；脚本停止时立即退出
     * @param {number} timeout 超时毫秒
     * @param {Set} baseline 点击前已存在的弹窗元素集合（排除残留弹窗，防止误当结果）
     */
    function waitForResultDialog(timeout = DIALOG_TIMEOUT, baseline = null) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const handledGroups = new Set();
            const timer = setInterval(() => {
                // 0. 脚本已停止：立即退出（不再继续等待弹窗）
                if (!isRunning) { clearInterval(timer); resolve(null); return; }
                // 1. 优先「选课结果」弹窗（排除点击前就存在的）
                const d = getVisibleResultDialog();
                if (d && (!baseline || !baseline.has(d.wrapper))) {
                    clearInterval(timer);
                    resolve({ ...d, kind: 'el-dialog', label: '选课结果', title: '选课结果' });
                    return;
                }
                // 2. 「上课小组」弹窗：有「确定」则自动点击推进流程；无确定按钮则关闭并报告
                const g = getVisibleGroupDialog();
                if (g && !handledGroups.has(g.wrapper) && (!baseline || !baseline.has(g.wrapper))) {
                    const buttons = g.dialog.querySelectorAll('button');
                    const okBtn = Array.from(buttons).find(btn =>
                        ['确定', '确认'].includes(btn.textContent.replace(/\s+/g, '').trim())
                    );
                    if (okBtn) {
                        handledGroups.add(g.wrapper);
                        log('检测到「上课小组」弹窗，已自动点击确定', 'info');
                        okBtn.click();
                    } else {
                        // 无法自动处理：关闭小组弹窗并返回，避免一直等待
                        clearInterval(timer);
                        log('「上课小组」弹窗无确定按钮，无法自动处理，已关闭', 'warning');
                        closeDialog({ wrapper: g.wrapper, dialog: g.dialog, kind: 'el-dialog' });
                        resolve({ dialog: g.dialog, kind: 'group-no-ok', label: '上课小组', title: '上课小组' });
                        return;
                    }
                }
                // 3. 任意可见弹窗/PNotify/message 兜底（排除加载弹窗 + 点击前已存在的）
                const any = getVisibleAnyResult();
                if (any && (!baseline || !baseline.has(any.wrapper))) {
                    clearInterval(timer);
                    resolve(any);
                    return;
                }
                // 4. 超时
                if (Date.now() - t0 > timeout) { clearInterval(timer); resolve(null); }
            }, speedCfg().dialogPoll);
        });
    }

    /** 读取结果文本（兼容 el-dialog / message-box / PNotify / el-message） */
    function readResultText(dialog) {
        if (!dialog || !dialog.dialog) return '';
        if (dialog.kind === 'pnotify' || dialog.kind === 'el-message' || dialog.kind === 'group-no-ok') {
            return (dialog.dialog.textContent || '').replace(/\s+/g, ' ').trim();
        }
        if (dialog.kind === 'message-box') {
            // $alert 消息框：标题 + 消息内容
            const titleEl = dialog.dialog.querySelector('.el-message-box__title');
            const msgEl = dialog.dialog.querySelector('.el-message-box__message');
            const title = titleEl ? titleEl.textContent.trim() : '';
            const msg = msgEl ? msgEl.textContent.trim() : '';
            return ((title ? title + ' ' : '') + msg).replace(/\s+/g, ' ').trim();
        }
        const contentEl = dialog.dialog.querySelector('.result-content');
        if (contentEl) return contentEl.textContent.replace(/\s+/g, ' ').trim();
        // 弹窗标题 + 正文（去掉按钮文本干扰）
        const bodyEl = dialog.dialog.querySelector('.el-dialog__body');
        const text = (bodyEl ? bodyEl.textContent : dialog.dialog.textContent) || '';
        return text.replace(/\s+/g, ' ').trim();
    }

    /** 关闭弹窗（兼容 el-dialog / message-box / PNotify / el-message） */
    function closeDialog(dialog) {
        if (!dialog || !dialog.dialog) return false;
        // PNotify / el-message 会自动消失，无需关闭
        if (dialog.kind === 'pnotify' || dialog.kind === 'el-message') return true;
        if (dialog.kind === 'message-box') {
            // 消息框：点「确定」或关闭按钮
            const btns = dialog.dialog.querySelectorAll('.el-message-box__btns button');
            for (const btn of btns) {
                const text = btn.textContent.replace(/\s+/g, '').trim();
                if (text === '确定' || text === 'OK' || text === '知道了') {
                    btn.click();
                    return true;
                }
            }
            const xBtn = dialog.dialog.querySelector('.el-message-box__headerbtn');
            if (xBtn) { xBtn.click(); return true; }
            return false;
        }
        const buttons = dialog.dialog.querySelectorAll('button');
        for (const btn of buttons) {
            const text = btn.textContent.replace(/\s+/g, '').trim();
            if (text === '关闭' || text === '确定' || text === '知道了') {
                btn.click();
                return true;
            }
        }
        // 兜底：点右上角 ×
        const closeBtn = dialog.dialog.querySelector('.el-dialog__headerbtn');
        if (closeBtn) { closeBtn.click(); return true; }
        return false;
    }

    /** 解析结果文本，返回 { type: 'success'|'conflict'|'full'|'closed'|'busy'|'fail'|'unknown', text } */
    function parseResult(text) {
        if (!text) return { type: 'unknown', text: '' };
        const SUCCESS = ['成功', '选课成功', '已选', '选中'];
        const CONFLICT = ['时间冲突', '冲突'];
        const FULL = ['已满', '满员', '容量已满', '人数已满'];
        const CLOSED = ['未开放', '不在选课时间', '未到选课时间', '选课时间未到', '尚未开放', '选课已结束', '选课未开始', '不在选课时间范围'];
        const BUSY = ['操作太过频繁', '太频繁', '稍后再试', '服务器繁忙'];
        const FAIL = ['失败', '不能', '无法', '不允许', '不符合', '超过上限', '限选', '已选过', '不能重复'];

        if (SUCCESS.some(k => text.includes(k))) return { type: 'success', text };
        if (CONFLICT.some(k => text.includes(k))) return { type: 'conflict', text };
        if (FULL.some(k => text.includes(k))) return { type: 'full', text };
        if (CLOSED.some(k => text.includes(k))) return { type: 'closed', text };
        if (BUSY.some(k => text.includes(k))) return { type: 'busy', text };
        if (FAIL.some(k => text.includes(k))) return { type: 'fail', text };
        return { type: 'unknown', text };
    }

    /** 模拟真实用户点击（完整事件序列，兼容对合成事件更敏感的页面逻辑） */
    function simulateRealClick(el) {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        try {
            if (typeof PointerEvent !== 'undefined') {
                el.dispatchEvent(new PointerEvent('pointerdown', opts));
                el.dispatchEvent(new PointerEvent('pointerup', opts));
            }
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
        } catch (e) {
            // 回退到原生 click()
            try { el.click(); } catch (e2) { /* 忽略 */ }
        }
    }

    /**
     * 执行一次选课点击并等待结果
     * @returns {Promise<{result: object, info: object}>}
     */
    async function clickSelectAndWait(info, courseCode) {
        if (!info.selectBtn) return { result: { type: 'fail', text: '无选课按钮' }, info };

        log(`尝试选课: ${info.courseName}${info.className ? ' ' + info.className : ''} (${info.teacher || '未知教师'})`, 'info', courseCode);
        if (info.timeInfo) log(`时间: ${info.timeInfo}`, 'info', courseCode);
        if (info.capacity) log(`人数: ${info.capacity}`, 'info', courseCode);

        // 记录已尝试的教学班（避免反复点同一行）
        const rowKey = info.className || info.courseName;
        getCourseState(courseCode).tried.add(rowKey);

        // 点击诊断准备：记录点击时间 + 观察点击后新增的弹窗类元素
        const clickAt = Date.now();
        const addedNodes = [];
        const mo = new MutationObserver(muts => {
            for (const m of muts) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const cls = String(node.getAttribute ? (node.getAttribute('class') || '') : '');
                    if (/dialog|pnotify|message|modal|alert|notify/i.test(cls)) {
                        addedNodes.push(`${node.tagName.toLowerCase()}[${cls.slice(0, 40)}] :: ${(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)}`);
                    }
                }
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });

        // 记录点击前已存在的弹窗（基线）：防止残留的旧消息框被误当作本次点击的结果
        const baseline = new Set();
        document.querySelectorAll('.el-dialog__wrapper, .el-message-box, .ui-pnotify, .el-message').forEach(el => {
            if (el.style && el.style.display !== 'none') baseline.add(el);
        });

        // 点击选课按钮（完整事件序列模拟真实点击）
        simulateRealClick(info.selectBtn);

        // 等待选课结果（自动处理「上课小组」弹窗；兼容结果弹窗/PNotify/el-message；排除基线弹窗）
        const dialog = await waitForResultDialog(DIALOG_TIMEOUT, baseline);
        mo.disconnect();
        if (!dialog) {
            // 超时诊断：可见弹窗 + 点击后新请求 + 点击后新增元素，精确定位无反馈原因
            const visibles = collectVisibleDialogs();
            const newReqs = (window.__recentRequests__ || []).filter(r => r.at >= clickAt).map(r => r.url);
            const parts = [];
            parts.push('可见弹窗: ' + (visibles.length > 0 ? visibles.join(' | ') : '无'));
            parts.push('点击后新请求: ' + (newReqs.length > 0 ? newReqs.slice(0, 5).join(' | ') : '无'));
            parts.push('点击后新增弹窗元素: ' + (addedNodes.length > 0 ? addedNodes.slice(0, 3).join(' | ') : '无'));
            log(`点击后未出现结果反馈（${parts.join('；')}）`, 'warning', courseCode);
            return { result: { type: 'unknown', text: `点击后未出现结果反馈（${parts.join('；')}）` }, info };
        }
        // 「上课小组」弹窗无法自动处理
        if (dialog.kind === 'group-no-ok') {
            return { result: { type: 'fail', text: '「上课小组」弹窗无确定按钮，需手动处理' }, info };
        }

        const text = readResultText(dialog);
        const result = parseResult(text);
        log(`选课结果(${dialog.kind}): ${text}`, result.type === 'success' ? 'success' : 'warning', courseCode);

        // 关闭弹窗
        closeDialog(dialog);

        // 关闭后等待页面刷新状态（时长随速度档位）
        await new Promise(r => setTimeout(r, speedCfg().postCloseDelay));

        // 若结果为成功或未知，再通过行状态二次确认（重新查找该课程的行）
        if (result.type === 'success' || result.type === 'unknown') {
            const confirmResult = verifyByRowStatus(courseCode);
            if (confirmResult === 'success') return { result: { type: 'success', text }, info };
            if (confirmResult === 'pending' && result.type === 'unknown') {
                return { result: { type: 'fail', text: text || '未知结果且状态未变化' }, info };
            }
        }
        return { result, info };
    }

    /**
     * 通过行的选课状态标签二次确认是否选课成功
     * @returns {'success'|'pending'|'gone'} success=状态已变化, pending=仍是待选课, gone=找不到该课程行了
     */
    function verifyByRowStatus(courseCode) {
        const rows = findAllRowsForCourse(courseCode);
        if (rows.length === 0) return 'gone';
        for (const info of rows) {
            // 只要有一行状态不再是「待选课」，说明选上了
            if (info.status && info.status !== '待选课') {
                return 'success';
            }
        }
        return 'pending';
    }

    // ========== 刷新列表 ==========

    /** 点击列表选课视图的「查询」按钮刷新数据 */
    function refreshList() {
        try {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = btn.textContent.replace(/\s+/g, '').trim();
                if (text === '查询' && isVisible(btn)) {
                    btn.click();
                    log('已触发「查询」刷新课程列表');
                    return true;
                }
            }
            log('未找到「查询」按钮，跳过刷新', 'warning');
            return false;
        } catch (e) {
            log(`刷新失败: ${e.message}`, 'warning');
            return false;
        }
    }

    // ========== 主抢课逻辑 ==========

    /** 单门课程的一次抢课尝试 */
    async function attemptGrabSingleCourse(courseCode) {
        const state = getCourseState(courseCode);
        if (state.selecting || state.success) return;
        if (state.failed >= MAX_FAILED_ATTEMPTS) return;

        state.attempts++;

        const rows = findAllRowsForCourse(courseCode);
        if (rows.length === 0) {
            log('当前页面未找到该课程的行（检查是否在正确的视图/是否已筛选）', 'warning', courseCode);
            return;
        }

        // 获取该课程的过滤配置
        const courseConfig = TARGET_COURSES.find(c => c.code === courseCode);
        const timeFilter = (courseConfig && courseConfig.timeFilter) || [];
        const teacherFilter = (courseConfig && courseConfig.teacherFilter) || [];
        const campusFilter = (courseConfig && courseConfig.campusFilter) || GLOBAL_CAMPUS_FILTER;

        // 逐个教学班尝试
        for (const info of rows) {
            if (state.success) return;
            if (state.failed >= MAX_FAILED_ATTEMPTS) return;

            const rowKey = info.className || info.courseName;
            if (state.conflicted.has(rowKey)) continue; // 已知时间冲突
            // 行级点击冷却：同一教学班冷却期内不重复点击（等待服务端状态更新，时长随速度档位）
            const lastClick = (state.lastClickAt && state.lastClickAt[rowKey]) || 0;
            if (Date.now() - lastClick < speedCfg().clickCooldown) continue;

            // 可抢性检查
            const check = checkRowSelectable(info);
            if (!check.ok) {
                log(`跳过 ${info.courseName}${info.className ? ' ' + info.className : ''}: ${check.reason}`, 'info', courseCode);
                continue;
            }

            // 过滤器
            if (!matchesTimeFilter(info.timeInfo, timeFilter)) {
                log(`⏭️ 跳过 ${info.className || info.courseName}: 时间不匹配过滤 [${timeFilter.join(',')}]`, 'info', courseCode);
                continue;
            }
            if (!matchesTeacherFilter(info.teacher, teacherFilter)) {
                log(`⏭️ 跳过 ${info.className || info.courseName}: 教师不匹配过滤 [${teacherFilter.join(',')}]`, 'info', courseCode);
                continue;
            }
            // 校区筛选（只对列表选课视图有效——培养方案行无校区信息不筛）
            if (!matchesCampusFilter(info.campus, campusFilter)) {
                log(`⏭️ 跳过 ${info.className || info.courseName}: 校区不匹配 [${campusFilter}]`, 'info', courseCode);
                continue;
            }
            // 课表冲突预检：点击前先比对课表，冲突则直接跳过（避免点完才弹「时间冲突」）
            const precheck = checkTimetableConflict(info.timeInfo);
            if (precheck.known && precheck.conflict) {
                log(`⏭️ 跳过 ${info.className || info.courseName}: 课表预检${precheck.reason}`, 'warning', courseCode);
                continue;
            }

            // 防频繁窗口检查：页面存在「操作太过频繁」提示时，关闭它并跳过本轮（避免无效点击）
            const freqBox = hasFrequentMessageBox();
            if (freqBox) {
                closeFrequentMessageBox(freqBox);
                if (!state.lastClickAt) state.lastClickAt = {};
                state.lastClickAt[rowKey] = Date.now() + 5000;
                log('⏳ 页面防频繁窗口未过，关闭提示并等待 5 秒', 'warning', courseCode);
                continue;
            }

            // 执行选课
            state.selecting = true;
            busy = true;
            if (!state.lastClickAt) state.lastClickAt = {};
            state.lastClickAt[rowKey] = Date.now();
            log(`🎯 发现可抢课程: ${info.courseName}${info.className ? ' ' + info.className : ''}`, 'success', courseCode);
            try {
                // API 直选优先（快且绕过前端弹窗缺陷）；接口路径不可用时回退到 DOM 点击
                let apiRes = null;
                if (API_DIRECT_ENABLED) {
                    log('🔌 API直选模式，直接调用选课接口...', 'info', courseCode);
                    apiRes = await apiSelectCourse(courseCode);
                }
                const { result } = (apiRes && apiRes.ok)
                    ? { result: { type: apiRes.type, text: apiRes.text } }
                    : await clickSelectAndWait(info, courseCode);
                state.lastResult = result.text;
                switch (result.type) {
                    case 'success':
                        state.failed = 0;
                        state.success = true;
                        selectedCourses.add(courseCode);
                        activeCourses.delete(courseCode);
                        log(`🎊 选课成功: ${courseCode} ${info.courseName}！`, 'success', courseCode);
                        notifySuccess(courseCode, info.courseName);
                        // 网课学分统计：选够目标学分自动停止网课抢课
                        if (parseOnlineCourse(info.courseName)) {
                            selectedOnlineCredits += (info.credit || 0);
                            log(`📚 网课学分累计: ${selectedOnlineCredits}/${ONLINE_TARGET_CREDITS}`, 'success', courseCode);
                            if (selectedOnlineCredits >= ONLINE_TARGET_CREDITS) {
                                stopOnlineCourses();
                            }
                        }
                        break;
                    case 'conflict':
                        state.conflicted.add(rowKey);
                        log(`🛑 时间冲突，换该课程其他教学班...`, 'error', courseCode);
                        break;
                    case 'full':
                        state.failed++;
                        log(`人数已满 (失败 ${state.failed}/${MAX_FAILED_ATTEMPTS})`, 'warning', courseCode);
                        break;
                    case 'closed':
                        state.failed++;
                        log(`未到选课时间或未开放 (失败 ${state.failed}/${MAX_FAILED_ATTEMPTS})`, 'warning', courseCode);
                        break;
                    case 'busy':
                        // 页面防频繁限制：不计入失败，指数退避（7秒 → 15秒 → 30秒 → 60秒封顶）
                        state.busyCount = (state.busyCount || 0) + 1;
                        const backoffMs = Math.min(7000 * Math.pow(2, state.busyCount - 1), 60000);
                        state.lastClickAt[rowKey] = Date.now() + backoffMs;
                        log(`⏳ 触发页面防频繁限制，自动退避 ${Math.round(backoffMs / 1000)} 秒（第 ${state.busyCount} 次）`, 'warning', courseCode);
                        break;
                    default:
                        state.failed++;
                        log(`失败/未知结果: ${result.text} (失败 ${state.failed}/${MAX_FAILED_ATTEMPTS})`, 'warning', courseCode);
                        break;
                }
            } catch (e) {
                state.failed++;
                log(`选课过程异常: ${e.message}`, 'error', courseCode);
            } finally {
                state.selecting = false;
                busy = false;
            }

            // 单门课一次轮询只点一次（避免连点同一门课的多个教学班）
            break;
        }

        // 该课程所有教学班都时间冲突
        if (state.conflicted.size > 0 && rows.length > 0 &&
            rows.every(info => state.conflicted.has(info.className || info.courseName))) {
            log('🛑 所有教学班都存在时间冲突，暂停该课程抢课', 'error', courseCode);
            activeCourses.delete(courseCode);
        }

        // 每 10 次尝试重置已尝试列表（教学班可能有新余量）
        if (state.attempts % 10 === 0) {
            state.tried.clear();
            log('已重置尝试记录，继续监控', 'info', courseCode);
        }
    }

    /** 一轮抢课尝试（多课程） */
    async function attemptGrabCourse() {
        if (busy) return; // 正在等待弹窗结果，本轮跳过
        if (!isRunning) return;

        attemptCount++;

        if (activeCourses.size === 0) {
            log('所有课程已完成，停止抢课', 'success');
            stopGrabbing();
            return;
        }

        // 加载弹窗显示中则等待
        if (isLoadingDialogVisible()) return;

        // 按优先级排序
        const sorted = Array.from(activeCourses).sort((a, b) => {
            const ca = TARGET_COURSES.find(c => c.code === a);
            const cb = TARGET_COURSES.find(c => c.code === b);
            return (ca ? ca.priority : 999) - (cb ? cb.priority : 999);
        });

        // 并发模式：同时尝试所有课程
        if (CONCURRENT_ENABLED) {
            for (const code of sorted) {
                await attemptGrabSingleCourse(code);
            }
        } else {
            for (const code of sorted) {
                await attemptGrabSingleCourse(code);
                break;
            }
        }
    }

    /** 抢课主循环（持续抢课直到：全部抢好 / 到自动停止时间 / 手动停止） */
    function startLoop() {
        attemptGrabCourse();
        intervalId = setInterval(async () => {
            if (!isRunning) return;
            // 自动停止时间检查
            if (endTime && Date.now() >= endTime.getTime()) {
                log(`⏰ 已到设置的停止时间 ${endTime.toLocaleString()}，自动停止抢课`, 'success');
                addUILog('success', '已到停止时间，自动停止抢课');
                stopGrabbing();
                return;
            }
            // 每隔 N 轮刷新一次列表
            if (attemptCount > 0 && attemptCount % speedCfg().refreshEvery === 0 && !busy) {
                refreshList();
                await new Promise(r => setTimeout(r, 1200)); // 等列表刷新完成
            }
            attemptGrabCourse();
        }, speedCfg().checkInterval);
    }

    // ========== 开始 / 停止 ==========

    function startGrabbing(customCourses = null) {
        if (isRunning) {
            log('抢课脚本已在运行中！', 'warning');
            return;
        }

        const coursesToGrab = customCourses || TARGET_COURSES;
        if (!coursesToGrab || coursesToGrab.length === 0) {
            log('❌ 未配置目标课程！请先在面板中添加课程', 'error');
            alert('请先添加目标课程！\n\n在面板中输入课程号或课程名称（如 053012R1 或 党史），点击「添加课程」。');
            return;
        }

        // 请求通知权限
        if (window.Notification && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        isRunning = true;
        attemptCount = 0;
        busy = false;
        courseStates.clear();
        selectedCourses.clear();
        activeCourses.clear();

        for (const course of coursesToGrab) {
            const courseCode = typeof course === 'string' ? course : course.code;
            activeCourses.add(courseCode);
            initCourseState(courseCode);
        }

        // 课表冲突预检运行时数据：扫描「已选课程」表的时间安排（比导入数据更及时）
        runtimeSelectedLessonEntries = scanSelectedLessonTimes();
        if (runtimeSelectedLessonEntries.length > 0) {
            log(`📚 已从「已选课程」提取 ${runtimeSelectedLessonEntries.length} 门课的时间用于冲突预检`, 'info');
        }

        // 网课学分基线：扫描「已选课程」中已选网课学分；超过目标则提醒手动退
        selectedOnlineCredits = scanSelectedOnlineCredits();
        if (selectedOnlineCredits > 0) {
            log(`📚 检测到已选网课 ${selectedOnlineCredits} 学分（本次抢课从该基线继续累计）`, 'info');
        }
        if (selectedOnlineCredits > ONLINE_TARGET_CREDITS) {
            const over = selectedOnlineCredits - ONLINE_TARGET_CREDITS;
            log(`⚠️ 已选网课 ${selectedOnlineCredits} 学分，超过目标 ${ONLINE_TARGET_CREDITS} 学分 ${over} 分！请手动退掉多余的课（脚本不自动退课）`, 'warning');
            alert(`⚠️ 提醒：你已选网课 ${selectedOnlineCredits} 学分，超过目标 ${ONLINE_TARGET_CREDITS} 学分 ${over} 分。\n\n脚本不会自动退课，请自行到「已选课程」手动退掉多余的网课。`);
        }

        log(`🚀 开始监控 ${activeCourses.size} 门课程: ${Array.from(activeCourses).join(', ')}`, 'success');
        log(`⚡ 速度档位: ${speedCfg().label}（轮询 ${speedCfg().checkInterval}ms，点击冷却 ${speedCfg().clickCooldown}ms，每 ${speedCfg().refreshEvery} 轮查询刷新）`, 'info');
        if (endTime) {
            log(`⏰ 自动停止时间: ${endTime.toLocaleString()}`, 'info');
        } else {
            log(`♾️ 持续抢课模式：直到全部抢好或手动停止`, 'info');
        }

        // 先刷新一次拿到最新数据
        refreshList();
        setTimeout(startLoop, 1500);

        updateStatusDisplay();
    }

    function stopGrabbing() {
        if (!isRunning) return;
        isRunning = false;
        busy = false;
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        log('⏹️ 抢课脚本已停止', 'warning');
        updateStatusDisplay();
    }

    function notifySuccess(courseCode, courseName) {
        try {
            if (window.Notification && Notification.permission === 'granted') {
                new Notification('抢课成功！', {
                    body: `成功选择: ${courseCode} - ${courseName}`
                });
            }
        } catch (e) { /* 忽略 */ }
    }

    // ========== 全局接口 ==========

    window.grab = {
        start: startGrabbing,
        stop: stopGrabbing,
        status: () => {
            console.log('%c========== 抢课状态 ==========', 'color: #00ffff; font-weight: bold; font-size: 16px;');
            console.table({
                isRunning,
                attemptCount,
                activeCourses: Array.from(activeCourses).join(', '),
                selectedCourses: Array.from(selectedCourses).join(', '),
                speed: speedCfg().label,
                checkInterval: speedCfg().checkInterval,
                endTime: endTime ? endTime.toLocaleString() : '无（持续抢课）'
            });
            return {
                isRunning, attemptCount,
                activeCourses: Array.from(activeCourses),
                selectedCourses: Array.from(selectedCourses),
                speed: speedCfg().label,
                endTime: endTime ? endTime.toLocaleString() : null
            };
        },
        debug: (courseCode = null) => {
            const codes = courseCode ? [courseCode] : Array.from(activeCourses);
            for (const code of codes) {
                log(`--- 调试: ${code} ---`, 'info');
                const rows = findAllRowsForCourse(code);
                log(`找到 ${rows.length} 个匹配行`, 'info');
                rows.forEach((info, i) => {
                    log(`行${i + 1}: ${info.courseName} | 班: ${info.className || '-'} | 教师: ${info.teacher || '-'} | 状态: ${info.status || '-'} | 人数: ${info.capacity || '-'} | 时间: ${info.timeInfo || '-'}`, 'info');
                    const check = checkRowSelectable(info);
                    log(`  可抢: ${check.ok ? '✅' : '❌ ' + check.reason}`, check.ok ? 'success' : 'warning');
                });
                if (rows.length === 0) {
                    log('没有找到匹配行——请确认当前在选课页面且课程在列表中可见', 'warning');
                }
            }
        },
        addCourse: (code, priority = 999) => {
            if (TARGET_COURSES.some(c => c.code === code)) {
                log(`课程 ${code} 已在列表中`, 'warning');
                return false;
            }
            TARGET_COURSES.push({ code, priority });
            log(`✅ 已添加课程 ${code} (优先级 ${priority})`, 'success');
            updateCourseList();
            return true;
        },
        removeCourse: (code) => {
            const idx = TARGET_COURSES.findIndex(c => c.code === code);
            if (idx === -1) return false;
            TARGET_COURSES.splice(idx, 1);
            activeCourses.delete(code);
            updateCourseList();
            log(`🗑️ 已移除课程 ${code}`, 'warning');
            return true;
        },
        schedule: (timeString) => {
            const t = new Date(timeString);
            if (isNaN(t.getTime())) {
                log('❌ 时间格式错误！请使用如: "2026-09-10 14:00:00"', 'error');
                return false;
            }
            setScheduledStart(t);
            return true;
        },
        cancelSchedule: cancelScheduledStart,

        // 手动导入课表数据（兜底方案，格式见注释）
        // 示例: grab.importTimetable([{name: '高等数学', slots: [{day: 1, periods: [1,2], weeks: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], oddEven: 'all'}]}])
        importTimetable: (data) => {
            if (!Array.isArray(data) || data.length === 0) {
                log('❌ 课表数据格式错误：应为数组 [{name, slots: [{day, periods, weeks, oddEven}]}]', 'error');
                return false;
            }
            if (saveTimetable(data)) {
                log(`✅ 已导入课表: ${data.length} 门课`, 'success');
                updateTimetableStatus();
                return true;
            }
            return false;
        },
        getTimetable: loadTimetable,
        importCapturedTimetable: importCapturedTimetable,   // 从网络拦截捕获的数据导入课表（兜底）

        // 退课相关（API 直退）
        dropCourse: apiDropCourse,                          // 退一门课: grab.dropCourse('智慧树:大学美育')
        dropOnlineCourses: (platform = '', keepCount = 0) => dropOnlineCourses(platform, keepCount),
        scanSelectedOnlineCourses: scanSelectedOnlineCourseNames,

        // 网课相关
        scanOnlineCourses: scanOnlineCourses,           // 扫描页面网课列表
        addOnlineCourses: addAllOnlineCourses,          // 一键添加全部网课
        setOnlineTargetCredits: (n) => {                // 设置网课目标学分
            if (n > 0 && n <= 30) {
                ONLINE_TARGET_CREDITS = n;
                log(`📚 网课目标学分已设置为: ${n}`, 'success');
                return true;
            }
            log('❌ 目标学分需在 1-30 之间', 'error');
            return false;
        },

        // 速度与停止时间
        setSpeed: (level) => {                          // 设置速度档位: 'fast' | 'normal' | 'safe'
            if (SPEED_PROFILES[level]) {
                SPEED_LEVEL = level;
                log(`⚡ 速度档位: ${speedCfg().label}`, 'success');
                return true;
            }
            log('❌ 速度档位需为 fast/normal/safe', 'error');
            return false;
        },
        setEndTime: (timeString) => {                   // 设置自动停止时间，如 "2026-09-15 12:00:00"
            if (!timeString) {
                endTime = null;
                log('♾️ 已清除停止时间（持续抢课）', 'info');
                return true;
            }
            const t = new Date(timeString);
            if (isNaN(t.getTime())) {
                log('❌ 时间格式错误！请使用如: "2026-09-15 12:00:00"', 'error');
                return false;
            }
            endTime = t;
            log(`⏰ 自动停止时间: ${t.toLocaleString()}`, 'success');
            return true;
        }
    };

    // ========== UI 面板 ==========

    function createUI() {
        if (document.getElementById('sdjuGrabberUI')) return;

        const style = document.createElement('style');
        style.textContent = `
            #sdjuGrabberUI {
                position: fixed; top: 20px; right: 20px; width: 420px; max-height: 90vh;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                z-index: 999999; color: white; overflow: hidden;
                display: flex; flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
            }
            #sdjuGrabberUI * { box-sizing: border-box; }
            .sg-header { padding: 16px 20px; background: rgba(0,0,0,0.2); cursor: move; display: flex; justify-content: space-between; align-items: center; user-select: none; }
            .sg-title { font-size: 16px; font-weight: bold; display: flex; align-items: center; gap: 8px; }
            .sg-close { background: rgba(255,255,255,0.2); border: none; color: white; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 16px; }
            .sg-close:hover { background: rgba(255,255,255,0.35); }
            .sg-body { padding: 16px 20px; overflow-y: auto; flex: 1; }
            .sg-section { background: rgba(255,255,255,0.1); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
            .sg-section-title { font-size: 13px; font-weight: bold; margin-bottom: 10px; opacity: 0.9; }
            .sg-input { width: 100%; padding: 9px 12px; border: 2px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.1); border-radius: 8px; color: white; font-size: 13px; margin-bottom: 6px; }
            .sg-input:focus { outline: none; border-color: rgba(255,255,255,0.5); }
            .sg-input::placeholder { color: rgba(255,255,255,0.5); }
            /* 下拉框选项：紫色底白字（避免系统默认白底白字看不见） */
            select.sg-input { background: linear-gradient(135deg, rgba(102,126,234,0.45), rgba(118,75,162,0.45)); cursor: pointer; }
            select.sg-input option { background: #4a3187; color: #ffffff; }
            select.sg-input option:hover, select.sg-input option:checked { background: #667eea; color: #ffffff; }
            /* 日期时间控件：深色配色 */
            input.sg-input[type="datetime-local"], input.sg-input[type="number"] { color-scheme: dark; }
            .sg-btn { padding: 9px 18px; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: bold; display: inline-flex; align-items: center; gap: 6px; justify-content: center; }
            .sg-btn-primary { background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%); color: #333; }
            .sg-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(67,233,123,0.4); }
            .sg-btn-danger { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; }
            .sg-btn-danger:hover { transform: translateY(-2px); }
            .sg-btn-secondary { background: rgba(255,255,255,0.2); color: white; }
            .sg-btn-secondary:hover { background: rgba(255,255,255,0.3); }
            .sg-btn-small { padding: 5px 10px; font-size: 12px; }
            .sg-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .sg-btn-group { display: flex; gap: 8px; margin-top: 10px; }
            .sg-course-list { max-height: 180px; overflow-y: auto; margin-top: 8px; }
            .sg-course-item { background: rgba(255,255,255,0.1); padding: 10px 12px; border-radius: 8px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
            .sg-course-code { font-weight: bold; font-size: 13px; }
            .sg-course-meta { font-size: 11px; opacity: 0.8; }
            .sg-status { padding: 8px 14px; background: rgba(255,255,255,0.1); border-radius: 8px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
            .sg-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #43e97b; animation: sgPulse 2s infinite; }
            @keyframes sgPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
            .sg-log-area { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 10px 12px; max-height: 140px; overflow-y: auto; font-size: 11px; font-family: 'Consolas', 'Monaco', monospace; line-height: 1.6; }
            .sg-log-success { color: #43e97b; }
            .sg-log-error { color: #f5576c; }
            .sg-log-warning { color: #ffa500; }
            .sg-log-info { color: #38f9d7; }
            .sg-timer { background: rgba(255,255,255,0.15); padding: 12px; border-radius: 8px; text-align: center; font-size: 22px; font-weight: bold; letter-spacing: 2px; margin-top: 8px; font-family: 'Consolas', monospace; }
            .sg-timer-active { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); animation: sgTimerPulse 1s infinite; }
            @keyframes sgTimerPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.02); } }
            .sg-help { font-size: 11px; opacity: 0.7; margin-top: 3px; }
            .sg-time-row { display: flex; gap: 8px; align-items: center; }
            .sg-time-row input { flex: 1; margin-bottom: 0; }
        `;
        document.head.appendChild(style);

        const ui = document.createElement('div');
        ui.id = 'sdjuGrabberUI';
        ui.innerHTML = `
            <div class="sg-header">
                <div class="sg-title"><span>🎓</span><span>自动抢课 · SDJU</span></div>
                <div style="display:flex;gap:8px;">
                    <button class="sg-close" id="sg-min-btn" title="最小化">−</button>
                    <button class="sg-close" id="sg-close-btn" title="关闭">×</button>
                </div>
            </div>
            <div class="sg-body">
                <div class="sg-section">
                    <div class="sg-section-title">📊 运行状态</div>
                    <div class="sg-status"><span class="sg-status-dot" id="sg-status-dot" style="display:none;"></span><span id="sg-status-text">未运行</span></div>
                </div>

                <div class="sg-section">
                    <div class="sg-section-title">⚙️ 抢课设置</div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span style="font-size:12px;opacity:0.8;white-space:nowrap;">校区筛选:</span>
                        <select class="sg-input" id="sg-campus-filter" style="flex:1;margin-bottom:0;cursor:pointer;">
                            <option value="不限">不限（两个校区都选）</option>
                            <option value="闵行校区">只选闵行校区</option>
                            <option value="临港校区" selected>只选临港校区</option>
                        </select>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span style="font-size:12px;opacity:0.8;white-space:nowrap;">速度:</span>
                        <select class="sg-input" id="sg-speed" style="flex:1;margin-bottom:0;cursor:pointer;">
                            <option value="normal" selected>🚀 标准（约1-2秒/课）</option>
                            <option value="fast">⚡ 快速（1秒内/课）</option>
                            <option value="turbo">🔥 极速（约0.5秒/课）</option>
                            <option value="safe">🐢 保守（防服务端限流）</option>
                        </select>
                    </div>
                    <div class="sg-help" id="sg-timetable-status">课表数据：未导入</div>
                    <button class="sg-btn sg-btn-secondary sg-btn-small" id="sg-scan-lessons" style="width:100%;margin-top:6px;">🔄 扫描已选课程</button>
                    <div class="sg-help">冲突预检数据来自本页「已选课程」的时间安排（开始抢课时自动扫描；学校排课后可点此按钮手动更新）</div>
                </div>

                <div class="sg-section">
                    <div class="sg-section-title">📚 网课专区（尔雅/智慧树）</div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                        <span style="font-size:12px;opacity:0.8;white-space:nowrap;">平台:</span>
                        <select class="sg-input" id="sg-platform-filter" style="flex:1;margin-bottom:0;cursor:pointer;">
                            <option value="all" selected>都选（智慧树优先）</option>
                            <option value="智慧树">只选智慧树</option>
                            <option value="尔雅">只选尔雅</option>
                        </select>
                    </div>
                    <button class="sg-btn sg-btn-primary sg-btn-small" id="sg-add-online" style="width:100%;">🎯 一键添加全部网课</button>
                    <div class="sg-help">扫描页面所有「智慧树:」「尔雅:」课程加入目标：智慧树优先、同学分平台学分高优先</div>
                    <div style="display:flex;align-items:center;gap:8px;margin-top:8px;">
                        <span style="font-size:12px;opacity:0.8;white-space:nowrap;">目标学分:</span>
                        <input type="number" class="sg-input" id="sg-online-credits" value="6" min="1" max="30" style="margin-bottom:0;">
                    </div>
                    <div class="sg-help">选够目标学分自动停止网课抢课；已选超过目标时提醒手动退课（脚本不自动退）</div>
                </div>

                <div class="sg-section">
                    <div class="sg-section-title">📚 添加目标课程（可选，非网课用）</div>
                    <input type="text" class="sg-input" id="sg-course-code" placeholder="课程号或课程名称 (例: 053012R1 或 党史)">
                    <input type="number" class="sg-input" id="sg-course-priority" placeholder="优先级 (数字越小越优先，默认1)" value="1" min="1">
                    <input type="text" class="sg-input" id="sg-time-filter" placeholder="时间过滤，可选 (例: 星期三,第5-6节)">
                    <input type="text" class="sg-input" id="sg-teacher-filter" placeholder="教师过滤，可选 (例: 张旭)">
                    <button class="sg-btn sg-btn-secondary sg-btn-small" id="sg-add-course" style="width:100%; margin-top:6px;">➕ 添加课程</button>
                </div>

                <div class="sg-section">
                    <div class="sg-section-title">📋 目标课程列表</div>
                    <div class="sg-course-list" id="sg-course-list"></div>
                </div>

                <div class="sg-section">
                    <div class="sg-section-title">⏰ 定时开抢</div>
                    <div class="sg-time-row">
                        <input type="datetime-local" class="sg-input" id="sg-schedule-time">
                        <button class="sg-btn sg-btn-secondary sg-btn-small" id="sg-schedule-btn">设置</button>
                    </div>
                    <div class="sg-help">设置开抢时间，到点自动开始（页面需保持打开）</div>
                    <div class="sg-time-row" style="margin-top:8px;">
                        <input type="datetime-local" class="sg-input" id="sg-end-time" style="margin-bottom:0;">
                        <button class="sg-btn sg-btn-secondary sg-btn-small" id="sg-end-time-btn">停止</button>
                    </div>
                    <div class="sg-help">可选：设置自动停止时间（如选课结束时间）。不设置则持续抢课，直到全部抢好或手动停止</div>
                    <div id="sg-timer-display" style="display:none;"></div>
                </div>

                <div class="sg-section">
                    <div class="sg-btn-group">
                        <button class="sg-btn sg-btn-primary" id="sg-start-btn" style="flex:1;">🚀 开始抢课</button>
                        <button class="sg-btn sg-btn-danger" id="sg-stop-btn" style="flex:1;" disabled>⏹️ 停止</button>
                    </div>
                    <div class="sg-btn-group">
                        <button class="sg-btn sg-btn-secondary sg-btn-small" id="sg-status-btn" style="flex:1;">📊 状态</button>
                        <button class="sg-btn sg-btn-secondary sg-btn-small" id="sg-debug-btn" style="flex:1;">🔍 调试</button>
                        <button class="sg-btn sg-btn-secondary sg-btn-small" id="sg-refresh-btn" style="flex:1;">🔄 刷新列表</button>
                    </div>
                </div>

                <div class="sg-section">
                    <div class="sg-section-title">📝 运行日志</div>
                    <div class="sg-log-area" id="sg-log-area"></div>
                </div>
            </div>
        `;
        document.body.appendChild(ui);

        makeDraggable(ui);
        bindUIEvents();
        updateCourseList();
        updateStatusDisplay();
        updateTimetableStatus();

        console.log('%c✨ SDJU 抢课脚本 UI 已加载！', 'color: #43e97b; font-weight: bold; font-size: 14px;');
    }

    function makeDraggable(element) {
        const header = element.querySelector('.sg-header');
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        header.onmousedown = (e) => {
            e.preventDefault();
            pos3 = e.clientX; pos4 = e.clientY;
            document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
            document.onmousemove = (ev) => {
                ev.preventDefault();
                pos1 = pos3 - ev.clientX; pos2 = pos4 - ev.clientY;
                pos3 = ev.clientX; pos4 = ev.clientY;
                element.style.top = (element.offsetTop - pos2) + 'px';
                element.style.left = (element.offsetLeft - pos1) + 'px';
                element.style.right = 'auto';
            };
        };
    }

    function bindUIEvents() {
        document.getElementById('sg-close-btn').onclick = () => {
            document.getElementById('sdjuGrabberUI').style.display = 'none';
        };
        document.getElementById('sg-min-btn').onclick = () => {
            const ui = document.getElementById('sdjuGrabberUI');
            const body = ui.querySelector('.sg-body');
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? '' : 'none';
            document.getElementById('sg-min-btn').textContent = hidden ? '−' : '□';
        };

        document.getElementById('sg-add-course').onclick = () => {
            const code = document.getElementById('sg-course-code').value.trim();
            const priority = parseInt(document.getElementById('sg-course-priority').value) || 1;
            if (!code) { alert('请输入课程号或课程名称！'); return; }
            if (TARGET_COURSES.some(c => c.code === code)) { alert('该课程已存在！'); return; }

            const finalCourse = { code, priority };
            const tf = safeParseFilterInput(document.getElementById('sg-time-filter').value);
            const pf = safeParseFilterInput(document.getElementById('sg-teacher-filter').value);
            if (tf.length) finalCourse.timeFilter = tf;
            if (pf.length) finalCourse.teacherFilter = pf;
            TARGET_COURSES.push(finalCourse);

            document.getElementById('sg-course-code').value = '';
            document.getElementById('sg-course-priority').value = '1';
            document.getElementById('sg-time-filter').value = '';
            document.getElementById('sg-teacher-filter').value = '';
            updateCourseList();
            addUILog('success', `已添加课程: ${code} (优先级: ${priority})${tf.length ? ` [时间: ${tf.join(',')}]` : ''}${pf.length ? ` [教师: ${pf.join(',')}]` : ''}`);
        };

        document.getElementById('sg-start-btn').onclick = () => {
            if (TARGET_COURSES.length === 0) { alert('请先添加至少一门课程！'); return; }
            window.grab.start();
            document.getElementById('sg-start-btn').disabled = true;
            document.getElementById('sg-stop-btn').disabled = false;
        };

        document.getElementById('sg-stop-btn').onclick = () => {
            window.grab.stop();
            document.getElementById('sg-start-btn').disabled = false;
            document.getElementById('sg-stop-btn').disabled = true;
        };

        document.getElementById('sg-status-btn').onclick = () => window.grab.status();
        document.getElementById('sg-debug-btn').onclick = () => window.grab.debug();
        document.getElementById('sg-refresh-btn').onclick = () => refreshList();

        // 校区筛选下拉
        document.getElementById('sg-campus-filter').onchange = (e) => {
            GLOBAL_CAMPUS_FILTER = e.target.value;
            addUILog('info', `校区筛选已设置为: ${e.target.value}`);
            log(`🏫 校区筛选: ${e.target.value}`, 'info');
        };

        // 速度档位下拉
        document.getElementById('sg-speed').onchange = (e) => {
            SPEED_LEVEL = e.target.value;
            log(`⚡ 速度档位切换: ${speedCfg().label}（轮询 ${speedCfg().checkInterval}ms，冷却 ${speedCfg().clickCooldown}ms）`, 'info');
            addUILog('info', `速度切换为: ${speedCfg().label}`);
        };

        // 自动停止时间
        document.getElementById('sg-end-time-btn').onclick = () => {
            const v = document.getElementById('sg-end-time').value;
            if (!v) {
                endTime = null;
                addUILog('warning', '已清除停止时间（持续抢课模式）');
                log('♾️ 已切换到持续抢课模式（直到全部抢好或手动停止）', 'info');
                return;
            }
            const t = new Date(v);
            if (t <= new Date()) { alert('停止时间必须大于当前时间！'); return; }
            endTime = t;
            addUILog('info', `已设置自动停止时间: ${t.toLocaleString()}`);
            log(`⏰ 自动停止时间: ${t.toLocaleString()}`, 'success');
        };

        // 扫描已选课程（冲突预检数据源）
        document.getElementById('sg-scan-lessons').onclick = () => {
            rescanSelectedLessonTimes();
        };

        // 网课专区
        document.getElementById('sg-add-online').onclick = () => {
            const added = addAllOnlineCourses();
            if (added > 0) {
                log(`提示: 共 ${added} 门网课已加入目标，可点击「开始抢课」`, 'info');
            }
        };
        document.getElementById('sg-platform-filter').onchange = (e) => {
            ONLINE_PLATFORM_FILTER = e.target.value;
            log(`📚 网课平台筛选: ${e.target.value === 'all' ? '都选' : '只选' + e.target.value}`, 'info');
            addUILog('info', `平台筛选已设置: ${e.target.value === 'all' ? '都选' : '只选' + e.target.value}`);
        };
        document.getElementById('sg-online-credits').onchange = (e) => {
            const v = parseInt(e.target.value);
            if (!isNaN(v) && v > 0 && v <= 30) {
                ONLINE_TARGET_CREDITS = v;
                addUILog('info', `网课目标学分已设置为: ${v}`);
                log(`📚 网课目标学分: ${v}`, 'info');
            } else {
                e.target.value = ONLINE_TARGET_CREDITS;
                alert('目标学分请输入 1-30 之间的数字');
            }
        };

        document.getElementById('sg-schedule-btn').onclick = () => {
            const timeInput = document.getElementById('sg-schedule-time');
            const timeValue = timeInput.value;
            if (!timeValue) { alert('请先选择开抢时间！'); return; }
            const t = new Date(timeValue);
            if (t <= new Date()) { alert('开抢时间必须大于当前时间！'); return; }
            if (TARGET_COURSES.length === 0) { alert('请先添加至少一门课程！'); return; }
            setScheduledStart(t);
        };

        setInterval(updateStatusDisplay, 1000);
    }

    function updateCourseList() {
        const list = document.getElementById('sg-course-list');
        if (!list) return;
        if (TARGET_COURSES.length === 0) {
            list.innerHTML = '<div style="text-align:center;opacity:0.6;padding:12px;">暂无课程，请先添加</div>';
            return;
        }
        list.innerHTML = TARGET_COURSES.map((course, index) => {
            let meta = '';
            if (course.timeFilter) meta += `⏰ ${course.timeFilter.join(',')} `;
            if (course.teacherFilter) meta += `👨‍🏫 ${course.teacherFilter.join(',')}`;
            return `
                <div class="sg-course-item">
                    <div>
                        <div class="sg-course-code">${course.code} <span style="font-size:11px;opacity:0.7;">优先级 ${course.priority}</span></div>
                        ${meta ? `<div class="sg-course-meta">${meta}</div>` : ''}
                    </div>
                    <button class="sg-btn sg-btn-danger sg-btn-small" data-remove-index="${index}" title="删除">🗑️</button>
                </div>`;
        }).join('');
        list.querySelectorAll('[data-remove-index]').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.getAttribute('data-remove-index'));
                const course = TARGET_COURSES[idx];
                if (confirm(`确定要删除课程 ${course.code} 吗？`)) {
                    TARGET_COURSES.splice(idx, 1);
                    updateCourseList();
                    addUILog('warning', `已删除课程: ${course.code}`);
                }
            };
        });
    }

    function updateStatusDisplay() {
        const statusText = document.getElementById('sg-status-text');
        const dot = document.getElementById('sg-status-dot');
        if (!statusText) return;
        if (isRunning) {
            statusText.textContent = `运行中 · 第${attemptCount}次 · 剩余课程: ${Array.from(activeCourses).join(', ') || '无'}`;
            if (dot) dot.style.display = '';
        } else {
            statusText.textContent = '未运行';
            if (dot) dot.style.display = 'none';
        }
    }

    function addUILog(type, message) {
        const logArea = document.getElementById('sg-log-area');
        if (!logArea) return;
        const time = new Date().toLocaleTimeString();
        const item = document.createElement('div');
        item.className = `sg-log-${type}`;
        item.textContent = `[${time}] ${message}`;
        logArea.appendChild(item);
        logArea.scrollTop = logArea.scrollHeight;
        while (logArea.children.length > 100) {
            logArea.removeChild(logArea.firstChild);
        }
    }

    // ========== 定时开抢 ==========

    function setScheduledStart(targetTime) {
        if (schedulerIntervalId) clearInterval(schedulerIntervalId);
        scheduledTime = targetTime;

        const timerDisplay = document.getElementById('sg-timer-display');
        if (timerDisplay) {
            timerDisplay.style.display = 'block';
            timerDisplay.className = 'sg-timer sg-timer-active';
        }
        document.getElementById('sg-start-btn').disabled = true;
        const scheduleBtn = document.getElementById('sg-schedule-btn');
        scheduleBtn.textContent = '❌取消';
        scheduleBtn.onclick = cancelScheduledStart;

        addUILog('info', `已设置定时开抢: ${targetTime.toLocaleString()}`);
        log(`⏰ 定时开抢已设置，将在 ${targetTime.toLocaleString()} 自动开始`, 'success');

        schedulerIntervalId = setInterval(() => {
            const diff = scheduledTime - new Date();
            if (diff <= 0) {
                clearInterval(schedulerIntervalId);
                if (timerDisplay) timerDisplay.style.display = 'none';
                addUILog('success', '⏰ 定时时间已到，开始抢课！');
                log('⏰ 定时时间已到，自动开始抢课！', 'success');
                scheduleBtn.textContent = '设置';
                document.getElementById('sg-start-btn').disabled = false;
                window.grab.start();
                document.getElementById('sg-start-btn').disabled = true;
                document.getElementById('sg-stop-btn').disabled = false;
            } else {
                updateCountdown(diff);
            }
        }, 100);
    }

    function cancelScheduledStart() {
        if (schedulerIntervalId) clearInterval(schedulerIntervalId);
        scheduledTime = null;
        const timerDisplay = document.getElementById('sg-timer-display');
        if (timerDisplay) timerDisplay.style.display = 'none';
        document.getElementById('sg-start-btn').disabled = false;
        const scheduleBtn = document.getElementById('sg-schedule-btn');
        scheduleBtn.textContent = '设置';
        scheduleBtn.onclick = null;
        // 重新绑定
        document.getElementById('sg-schedule-btn').onclick = () => {
            const timeInput = document.getElementById('sg-schedule-time');
            const timeValue = timeInput.value;
            if (!timeValue) { alert('请先选择开抢时间！'); return; }
            const t = new Date(timeValue);
            if (t <= new Date()) { alert('开抢时间必须大于当前时间！'); return; }
            if (TARGET_COURSES.length === 0) { alert('请先添加至少一门课程！'); return; }
            setScheduledStart(t);
        };
        addUILog('warning', '已取消定时开抢');
        log('⏰ 定时开抢已取消', 'warning');
    }

    function updateCountdown(ms) {
        const timerDisplay = document.getElementById('sg-timer-display');
        if (!timerDisplay) return;
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const msPart = Math.floor((ms % 1000) / 10);
        const timeString = hours > 0
            ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
            : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(msPart).padStart(2, '0')}`;
        timerDisplay.textContent = `⏰ ${timeString}`;
        if (totalSeconds <= 10 && totalSeconds > 0) {
            timerDisplay.style.animation = 'sgTimerPulse 0.5s infinite';
        }
    }

    // ========== 自动创建 UI ==========
    // 脚本通过 @match 只注入选课页面（https://jwgl.sdju.edu.cn/course-selection/*），
    // 首页等其他页面不会出现任何脚本界面。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
        // 兜底：3 秒后仍未创建则强制创建（防止事件丢失）
        setTimeout(() => {
            if (!document.getElementById('sdjuGrabberUI')) createUI();
        }, 3000);
    } else {
        createUI();
    }

    window.showGrabberUI = () => {
        const ui = document.getElementById('sdjuGrabberUI');
        if (ui) {
            ui.style.display = 'flex';
        } else {
            createUI();
        }
    };

    // ========== 日志替换（在模块末尾执行，覆盖所有 log 调用路径） ==========
    // function 声明可以重新赋值，因此直接替换 log 变量为带 UI 输出的版本
    (function replaceLogForUI() {
        const original = log;
        // eslint-disable-next-line no-func-assign
        log = function (message, type = 'info', courseCode = null) {
            original(message, type, courseCode);
            try {
                const prefix = courseCode ? `[${courseCode}] ` : '';
                addUILog(type, prefix + message);
            } catch (e) { /* UI 未创建时忽略 */ }
        };
    })();

    // ========== 加载提示 ==========
    console.log('%c🎓 SDJU 自动抢课脚本已加载（个人适配版 v1.4.0）', 'color: #ff6b35; font-size: 18px; font-weight: bold;');
    console.log('%c📚 使用: 网课专区「一键添加全部网课」→「开始抢课」/「定时开抢」', 'color: #4ecdc4; font-size: 14px; font-weight: bold;');
    console.log('%c💡 冲突预检数据来自本页「已选课程」时间（开始抢课时自动扫描）', 'color: #45b7d1; font-size: 13px;');
})();
