// Minimalist Web Notepad - Cloudflare 前端自动保存脚本(增强版)
// 基于 static/script.js 改造,适配客户端渲染:
//   - 进入页面时通过 fetch GET /api/<path> 加载已保存内容
//   - 加载完成后启动 1 秒轮询,内容变化则 POST /api/<path>
//   - 路径分离:页面用 /<path>,API 用 /api/<path>
//
// 增强项:
//   - beforeunload 最终保存(sendBeacon),减少关闭丢字
//   - 保存成功/失败状态提示
//   - 初始加载与轮询时序修复(避免空内容覆盖已有数据)

// 获取元素引用
var textarea = document.getElementById('content');
var printable = document.getElementById('printable');
var statusEl = document.getElementById('status');

// 由当前页面路径推导 API 路径
// window.location.pathname 形如 /12345678,API 路径为 /api/12345678
var pagePath = window.location.pathname;
var apiPath = '/api' + pagePath;

// 记录上次已上传内容(初始为空,加载完成后会被覆盖)
var content = '';
// 状态提示自动隐藏定时器
var statusTimer = null;

/**
 * 显示状态提示
 * @param {string} type - 'success' | 'error'
 * @param {string} message - 提示文本
 */
function showStatus(type, message) {
    statusEl.textContent = message;
    statusEl.className = 'show ' + type;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
        statusEl.className = '';
    }, 3000);
}

// 1) 初始加载已保存内容,完成后启动轮询
//    使用默认 cache 策略,允许浏览器与服务器通过 ETag 协商
//    (服务器返回 304 时浏览器透明复用缓存,减少传输)
//    必须等加载完成再启动 checkAndUploadContent,否则首次轮询会用空内容
//    覆盖服务端已有数据(修复原项目潜在的时序问题)
fetch(apiPath)
    .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
    })
    .then(function (text) {
        textarea.value = text;
        content = text;
    })
    .catch(function (err) {
        // 加载失败时静默处理(空内容开始编辑),仍启动轮询
        console.error('Load failed:', err);
    })
    .finally(function () {
        checkAndUploadContent();
    });

// 2) 定期检查并上传内容
function checkAndUploadContent() {
    var currentContent = textarea.value;
    if (currentContent !== content) {
        uploadContent(currentContent, true);
        content = currentContent;
    }
    // 1 秒后再次检查
    setTimeout(checkAndUploadContent, 1000);
}

/**
 * 上传内容到服务端
 * @param {string} currentContent - 当前文本
 * @param {boolean} showFeedback - 是否显示成功/失败提示(轮询显示,beforeunload 不显示)
 */
function uploadContent(currentContent, showFeedback) {
    var request = new XMLHttpRequest();
    request.open('POST', apiPath, true);
    request.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');

    // 始终绑定 onload/onerror:失败时回滚 content,下次轮询自动重试,避免丢内容
    // (content 在 checkAndUploadContent 中已乐观更新,此处仅负责失败回滚)
    request.onload = function () {
        if (request.status !== 200) {
            // 保存失败:回滚 content,下次轮询 currentContent !== null 触发重试
            content = null;
        }
        if (!showFeedback) return;
        if (request.status === 200) {
            showStatus('success', '已保存');
        } else if (request.status === 429) {
            showStatus('error', '操作过快,请稍候');
        } else if (request.status === 413) {
            showStatus('error', '内容过大,保存失败');
        } else {
            showStatus('error', '保存失败 (' + request.status + ')');
        }
    };
    request.onerror = function () {
        // 网络错误:回滚 content,下次轮询重试
        content = null;
        if (showFeedback) showStatus('error', '网络错误,保存失败');
    };

    request.send(currentContent);

    // 更新 printable 的内容(用于打印视图)
    while (printable.firstChild) {
        printable.removeChild(printable.firstChild);
    }
    printable.appendChild(document.createTextNode(currentContent));
}

// 3) 页面关闭前最终保存(sendBeacon)
//    sendBeacon 在 unload 场景下比 XHR 更可靠,浏览器保证在页面卸载后排队发送
//    注意:sendBeacon 不保证服务端处理完成,仅"尽力而为",比 XHR 在 unload 时被取消更强
window.addEventListener('beforeunload', function () {
    var currentContent = textarea.value;
    if (currentContent !== content) {
        var blob = new Blob([currentContent], { type: 'application/x-www-form-urlencoded' });
        navigator.sendBeacon(apiPath, blob);
        content = currentContent;
    }
});
