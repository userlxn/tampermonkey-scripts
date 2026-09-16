// ==UserScript==
// @name         豆包网页版深色模式切换
// @namespace    https://github.com/userlxn/tampermonkey-scripts/
// @license      MIT
// @version      2.0.0
// @description  为豆包网页版添加深色模式切换按钮，强制覆盖多个CSS变量，支持配置持久化（属性强制成功，低CPU）
// @author       userlxn
// @match        *://doubao.com/*
// @match        *://*.doubao.com/*
// @grant        none
// @supportURL   https://github.com/userlxn/tampermonkey-scripts/tree/main/%E8%B1%86%E5%8C%85%E7%BD%91%E9%A1%B5%E7%89%88%E6%B7%B1%E8%89%B2%E6%A8%A1%E5%BC%8F%E5%88%87%E6%8D%A2/issues
// @homepageURL  https://greasyfork.org/zh-CN/scripts/595973-%E8%B1%86%E5%8C%85%E7%BD%91%E9%A1%B5%E7%89%88%E6%B7%B1%E8%89%B2%E6%A8%A1%E5%BC%8F%E5%88%87%E6%8D%A2
// @downloadURL  https://update.greasyfork.org/scripts/595973/%E8%B1%86%E5%8C%85%E7%BD%91%E9%A1%B5%E7%89%88%E6%B7%B1%E8%89%B2%E6%A8%A1%E5%BC%8F%E5%88%87%E6%8D%A2.user.js
// @updateURL    https://update.greasyfork.org/scripts/595973/%E8%B1%86%E5%8C%85%E7%BD%91%E9%A1%B5%E7%89%88%E6%B7%B1%E8%89%B2%E6%A8%A1%E5%BC%8F%E5%88%87%E6%8D%A2.user.js
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'doubao-theme';
    const TARGET_SELECTOR = '.md-box-root, .flow-web-root-outlet';

    // 按钮样式
    const themeStyles = {
        light: {
            bg: '#F5F5F5',
            hoverBg: '#F0F0F0',
            color: '#666666',
            shadow: '0 2px 8px rgba(0,0,0,0.2)'
        },
        dark: {
            bg: '#2a2a2a',
            hoverBg: '#3a3a3a',
            color: '#e0e0e0',
            shadow: '0 2px 8px rgba(0,0,0,0.4)'
        }
    };

    // CSS 变量映射
    const colorMap = {
        '--md-box-color-fg': { light: '#323232', dark: '#e0e0e0' },
        '--md-box-color-surface-muted': { light: '#d3d3d3', dark: '#f3f3f3' },
        '--s-color-text-secondary': { light: '#666666', dark: '#b0b0b0' },
        '--s-color-text-tertiary': { light: '#999999', dark: '#888888' },
        '--dbx-text-primary': { light: '#1a1a1a', dark: '#e8e8e8' },
        '--dbx-text-tertiary': { light: '#999999', dark: '#888888' },
        '--s-color-bg-trans': { light: 'rgba(0,0,0,0.04)', dark: 'rgba(255,255,255,0.08)' }
    };

    // 全局额外样式 - 增强全局强制覆盖，确保动态元素也生效
    const extraStyle = document.createElement('style');
    extraStyle.textContent = `
        /* 强制背景色（已有规则） */
        html[data-theme="dark"] [class*="bg-[var(--bg-base-2"] {
            background-color: #1f1f1f !important;
        }
        /* 针对消息容器及其所有子元素强制字体颜色 */
        html[data-theme="dark"] .md-box-root,
        html[data-theme="dark"] .flow-web-root-outlet,
        html[data-theme="dark"] .md-box-root *,
        html[data-theme="dark"] .flow-web-root-outlet * {
            color: var(--dbx-text-primary, #e8e8e8) !important;
        }
        /* 全局 body 兜底 */
        html[data-theme="dark"] body {
            color: #e8e8e8 !important;
        }
    `;
    document.head.appendChild(extraStyle);

    // ---------- 状态 ----------
    let expectedTheme = null;          // 当前期望的主题
    let targetObserver = null;         // 用于等待目标元素出现
    let attrObserver = null;           // 用于监听 data-theme 属性变化

    // ---------- 工具：设置 data-theme 属性（带重试） ----------
    function setThemeAttribute(theme, retries = 3) {
        const root = document.documentElement;
        if (!root) return false;

        let success = false;
        for (let i = 0; i < retries; i++) {
            root.setAttribute('data-theme', theme);
            // 验证是否设置成功
            if (root.getAttribute('data-theme') === theme) {
                success = true;
                break;
            }
            // 不成功则等待 100ms 重试
            if (i < retries - 1) {
                const start = Date.now();
                while (Date.now() - start < 100) { /* 同步等待，不阻塞主线程太长时间 */ }
            }
        }
        return success;
    }

    // ---------- 属性防篡改观察器 ----------
    function startAttributeGuard() {
        if (attrObserver) attrObserver.disconnect();
        attrObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                    const current = document.documentElement.getAttribute('data-theme');
                    // 如果当前属性值与期望值不符，则强制改回
                    if (expectedTheme !== null && current !== expectedTheme) {
                        // 暂时断开观察，避免循环
                        attrObserver.disconnect();
                        document.documentElement.setAttribute('data-theme', expectedTheme);
                        // 重新连接
                        attrObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
                    }
                }
            }
        });
        attrObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    // ---------- 核心应用 ----------
    function setRootVariables(theme) {
        const root = document.documentElement;
        Object.entries(colorMap).forEach(([varName, colors]) => {
            root.style.setProperty(varName, colors[theme], 'important');
        });
    }

    function setTargetVariables(theme) {
        const targets = document.querySelectorAll(TARGET_SELECTOR);
        if (targets.length === 0) return false;
        targets.forEach(el => {
            Object.entries(colorMap).forEach(([varName, colors]) => {
                el.style.setProperty(varName, colors[theme], 'important');
            });
        });
        return true;
    }

    function applyTheme(theme, waitForTarget = true) {
        // 更新期望主题
        expectedTheme = theme;

        // 1. 设置 html 属性（带重试，确保成功）
        const attrSuccess = setThemeAttribute(theme, 3);
        if (!attrSuccess) {
            console.warn('[豆包深色模式] data-theme 属性设置失败，但将继续尝试设置变量');
        }

        // 2. 设置根变量
        setRootVariables(theme);

        // 3. 尝试设置目标元素变量
        const targetSuccess = setTargetVariables(theme);
        if (targetSuccess) {
            stopTargetObserver();
        } else if (waitForTarget) {
            stopTargetObserver();
            targetObserver = new MutationObserver(() => {
                if (setTargetVariables(theme)) {
                    stopTargetObserver();
                }
            });
            targetObserver.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        }
        return targetSuccess;
    }

    function stopTargetObserver() {
        if (targetObserver) {
            targetObserver.disconnect();
            targetObserver = null;
        }
    }

    // ---------- 主题切换 ----------
    function saveTheme(theme) {
        localStorage.setItem(STORAGE_KEY, theme);
    }

    function getSavedTheme() {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved === 'dark' ? 'dark' : 'light';
    }

    function toggleTheme(btn) {
        const newTheme = expectedTheme === 'dark' ? 'light' : 'dark';
        applyTheme(newTheme, true);
        saveTheme(newTheme);
        btn.innerText = newTheme === 'dark' ? '☀️ 浅色' : '🌙 深色';
        updateButtonStyle(btn, newTheme);
    }

    // ---------- 按钮 ----------
    function updateButtonStyle(btn, theme) {
        const style = themeStyles[theme];
        btn.style.background = style.bg;
        btn.style.color = style.color;
        btn.style.boxShadow = style.shadow;
        btn.onmouseover = () => { btn.style.background = style.hoverBg; };
        btn.onmouseout = () => { btn.style.background = style.bg; };
    }

    function createToggleButton(initialTheme) {
        const btn = document.createElement('button');
        btn.id = 'doubao-theme-toggle';
        btn.innerText = initialTheme === 'dark' ? '☀️ 浅色' : '🌙 深色';
        updateButtonStyle(btn, initialTheme);

        btn.style.cssText = `
            position: fixed;
            top: 10px;
            left: 100px;
            padding: 8px 16px;
            border: none;
            border-radius: 20px;
            font-size: 14px;
            cursor: pointer;
            z-index: 999999;
            outline: none;
            transition: background 0.2s, color 0.2s, box-shadow 0.2s;
        `;

        btn.addEventListener('click', function(e) {
            toggleTheme(this);
        });

        return btn;
    }

    // ---------- 初始化 ----------
    function init() {
        const theme = getSavedTheme();
        applyTheme(theme, true);
        // 启动属性防篡改观察
        startAttributeGuard();
        // 创建按钮
        const btn = createToggleButton(theme);
        document.body.appendChild(btn);
    }

    // 等待 DOM 就绪
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();