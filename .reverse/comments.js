const MAX_CONTENT_LENGTH = 72;
const SUBMIT_TIMEOUT_MS = 15000;
const MOCK_SYNC_DELAY_MS = 500;
const ENABLE_COOLDOWN = false;
const COOLDOWN_MS = 30000;

import { cropperSystem } from './cropper-mod.js';

export function createCommentController() {
    let elements = null;
    let refreshMessages = null;
    let submitState = 'idle';
    let cooldownUntil = 0;
    let isContentComposing = false;
    let isNicknameComposing = false;
    let currentCroppedData = null;
    let isAdvicesNicknameComposing = false;
    let syncProgressTimer = null;
    let syncSpinnerTimer = null;

    function getStoredComments() {
        // Temporary no-op: disable local persisted comments while keeping submit flow.
        return [];
    }

    function buildPayload({ nickname, content, imageFile, formType, adviceType }) {
        const payload = new FormData();
        payload.append('author', nickname);
        payload.append('content', content);

        if (formType === 'advices' && adviceType) {
            payload.append('type', adviceType);
        }

        console.log('[Comments] currentCroppedData:', currentCroppedData);
        if (currentCroppedData && currentCroppedData.blob) {
            console.log('[Comments] 使用裁剪后的图片，大小:', currentCroppedData.blob.size, '类型:', currentCroppedData.blob.type, '格式:', currentCroppedData.format);
            payload.append('image_url', currentCroppedData.blob, 'upload.jpg');
            if (formType === 'messages') {
                payload.append('format', currentCroppedData.format);
            }
        } else if (imageFile) {
            console.log('[Comments] 使用原始图片文件:', imageFile.name, '大小:', imageFile.size);
            payload.append('image_url', imageFile);
        } else {
            console.log('[Comments] 没有图片附件');
        }
        return payload;
    }

    function formatCounter(length) {
        return `${String(length).padStart(2, '0')}/${MAX_CONTENT_LENGTH}`;
    }

    function attach({ refreshMessages: refreshFn } = {}) {
        refreshMessages = refreshFn || null;
        elements = {
            fab: document.getElementById('comment-fab'),
            overlay: document.getElementById('terminal-overlay'),
            closeBtn: document.getElementById('terminal-close-btn'),
            // 消息表单元素
            nickname: document.getElementById('terminal-nickname'),
            content: document.getElementById('terminal-content'),
            counter: document.getElementById('terminal-counter'),
            // 反馈表单元素
            advicesNickname: document.getElementById('advices-nickname'),
            advicesContent: document.getElementById('advices-content'),
            // 上传相关
            uploadTrigger: document.getElementById('terminal-upload-trigger'),
            imageInput: document.getElementById('comment-image-input'),
            uploadStatus: document.getElementById('upload-status-text'),
            // 同步反馈（保留现有）
            syncFeedback: document.getElementById('comment-sync-feedback'),
            syncBar: document.getElementById('comment-sync-bar'),
            syncLabel: document.getElementById('comment-sync-label'),
            syncSpinner: document.getElementById('sync-spinner'),
            syncPercent: document.getElementById('comment-sync-percent'),
            // 视图容器
            views: {
                menu: document.getElementById('v-menu'),
                messages: document.getElementById('v-msg'),
                advices: document.getElementById('v-adv'),
                info: document.getElementById('v-inf')
            },
            // 发送按钮
            sendBtn: document.getElementById('terminal-send-btn'),
            advicesSendBtn: document.getElementById('advices-send-btn')
        };

        if (!elements.fab || !elements.overlay || !elements.views.menu) {
            console.warn('Comment controller failed to attach: required elements missing');
            return;
        }

        // 确保终端界面初始状态正确
        elements.overlay.hidden = true;
        elements.overlay.classList.remove('active');

        console.log('Terminal controller attached successfully');

        syncCounter();
        bindEvents();
    }

    function bindEvents() {
        // FAB 按钮事件
        elements.fab.addEventListener('click', openOverlay);
        elements.fab.addEventListener('pointerdown', function() {
            this.classList.add('is-pressed');
        });
        elements.fab.addEventListener('pointerup', function() {
            this.classList.remove('is-pressed');
            this.classList.add('is-released');
            setTimeout(() => {
                this.classList.remove('is-released');
            }, 400);
        });
        elements.fab.addEventListener('pointerleave', function() {
            this.classList.remove('is-pressed');
        });
        elements.fab.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.click();
            }
        });

        // 终端关闭按钮（如果存在）
        if (elements.closeBtn) {
            elements.closeBtn.addEventListener('click', closeOverlay);
        }
        elements.overlay.addEventListener('click', (event) => {
            if (event.target === elements.overlay) {
                closeOverlay();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !elements.overlay.hidden) closeOverlay();
        });

        // 主菜单选项点击 - 视图切换
        document.querySelectorAll('.terminal-main-opt').forEach(opt => {
            opt.addEventListener('click', function() {
                console.log('Terminal option clicked:', this.getAttribute('data-view'));
                const viewId = this.getAttribute('data-view');
                if (viewId === 'quit') {
                    closeOverlay();
                } else {
                    switchView(viewId);
                }
            });
        });

        // 子界面返回按钮
        document.querySelectorAll('.terminal-sub-opt[data-view]').forEach(opt => {
            opt.addEventListener('click', function() {
                const viewId = this.getAttribute('data-view');
                switchView(viewId);
            });
        });

        // ADVICES 单选逻辑
        document.querySelectorAll('.terminal-radio-item').forEach(item => {
            item.addEventListener('click', function() {
                selectRadioItem(this);
            });
        });

        // 图片上传绑定
        if (elements.imageInput && elements.uploadTrigger) {
            elements.uploadTrigger.onclick = () => {
                elements.imageInput.click();
            };

            elements.imageInput.onchange = async function() {
                if (this.files && this.files[0]) {
                    const file = this.files[0];
                    console.log('[Comments] 图片选择:', file.name, '大小:', file.size, '类型:', file.type);
                    try {
                        const result = await cropperSystem.open(file);
                        console.log('[Comments] 裁剪成功:', result);
                        currentCroppedData = result;

                        if (elements.uploadStatus) {
                            elements.uploadStatus.innerText = `READY: [${result.format.toUpperCase()}]`;
                            elements.uploadStatus.classList.add('ready');
                        }
                    } catch (e) {
                         console.error('[Comments] 裁剪失败:', e.message, e.stack || e);
                         if (!currentCroppedData && elements.uploadStatus) {
                             elements.uploadStatus.innerText = "IMAGE ATTACHMENT AREA";
                             elements.uploadStatus.classList.remove('ready');
                         }
                    }
                }
            };
        }

        // 消息表单输入事件
        if (elements.content) {
            elements.content.addEventListener('compositionstart', () => {
                isContentComposing = true;
            });
            elements.content.addEventListener('compositionend', () => {
                isContentComposing = false;
                normalizeContentValue();
                syncCounter();
            });
            elements.content.addEventListener('input', () => {
                if (!isContentComposing) {
                    normalizeContentValue();
                }
                syncCounter();
            });
        }

        if (elements.nickname) {
            elements.nickname.addEventListener('compositionstart', () => {
                isNicknameComposing = true;
            });
            elements.nickname.addEventListener('compositionend', () => {
                isNicknameComposing = false;
                normalizeNicknameValue();
            });
            elements.nickname.addEventListener('input', () => {
                if (!isNicknameComposing) {
                    normalizeNicknameValue();
                }
            });
        }

        // 反馈表单输入事件
        if (elements.advicesContent) {
            elements.advicesContent.addEventListener('input', normalizeAdvicesContentValue);
        }
        if (elements.advicesNickname) {
            elements.advicesNickname.addEventListener('compositionstart', () => {
                isAdvicesNicknameComposing = true;
            });
            elements.advicesNickname.addEventListener('compositionend', () => {
                isAdvicesNicknameComposing = false;
                normalizeAdvicesNicknameValue();
            });
            elements.advicesNickname.addEventListener('input', () => {
                if (!isAdvicesNicknameComposing) {
                    normalizeAdvicesNicknameValue();
                }
            });
        }

        // 发送按钮点击事件
        if (elements.sendBtn) {
            elements.sendBtn.addEventListener('click', handleMessagesSubmit);
        }
        if (elements.advicesSendBtn) {
            elements.advicesSendBtn.addEventListener('click', handleAdvicesSubmit);
        }
    }

    function normalizeNicknameValue() {
        if (!elements?.nickname) return;
        // 移除错误状态
        elements.nickname.classList.remove('error');
        const trimmedLeading = elements.nickname.value.replace(/^\s+/, '');
        if (trimmedLeading !== elements.nickname.value) {
            elements.nickname.value = trimmedLeading;
        }
    }

    function normalizeContentValue() {
        if (!elements?.content) return;
        // 移除错误状态
        elements.content.classList.remove('error');
        if (elements.content.value.length > MAX_CONTENT_LENGTH) {
            elements.content.value = elements.content.value.slice(0, MAX_CONTENT_LENGTH);
        }
    }

    function normalizeAdvicesContentValue() {
        if (!elements?.advicesContent) return;
        // 移除错误状态
        elements.advicesContent.classList.remove('error');
        const MAX_ADVICES_LENGTH = 200;
        if (elements.advicesContent.value.length > MAX_ADVICES_LENGTH) {
            elements.advicesContent.value = elements.advicesContent.value.slice(0, MAX_ADVICES_LENGTH);
        }
    }

    function normalizeAdvicesNicknameValue() {
        if (!elements?.advicesNickname) return;
        // 移除错误状态
        elements.advicesNickname.classList.remove('error');
        const trimmedLeading = elements.advicesNickname.value.replace(/^\s+/, '');
        if (trimmedLeading !== elements.advicesNickname.value) {
            elements.advicesNickname.value = trimmedLeading;
        }
    }

    function syncCounter() {
        if (!elements?.counter || !elements?.content) return;
        elements.counter.textContent = formatCounter(elements.content.value.length);
    }

    function openOverlay() {
        if (!elements || submitState === 'submitting') return;
        elements.overlay.hidden = false;
        elements.overlay.classList.add('active');

        // 清除所有输入框的错误状态
        if (elements.nickname) elements.nickname.classList.remove('error');
        if (elements.content) elements.content.classList.remove('error');
        if (elements.advicesNickname) elements.advicesNickname.classList.remove('error');
        if (elements.advicesContent) elements.advicesContent.classList.remove('error');

        requestAnimationFrame(() => {
            elements.nickname.focus({ preventScroll: true });
            elements.nickname.select();
        });
    }

    function closeOverlay() {
        console.log('Closing overlay');
        if (!elements || submitState === 'submitting') return;
        elements.overlay.hidden = true;
        elements.overlay.classList.remove('active');
        setStatus('');
        // 返回到主菜单
        switchView('v-menu');
    }

    // 终端视图切换
    function switchView(viewId) {
        if (!elements?.views) return;

        // 隐藏所有视图
        Object.values(elements.views).forEach(view => {
            if (view) {
                view.classList.add('hidden');
            }
        });

        // 显示目标视图
        const targetView = elements.views[viewId] || document.getElementById(viewId);
        if (targetView) {
            targetView.classList.remove('hidden');
        }

        // 如果是主菜单，确保flex布局
        if (viewId === 'v-menu' && targetView) {
            targetView.style.display = 'flex';
        }
    }

    // 单选项目选择
    function selectRadioItem(selectedItem) {
        if (!selectedItem) return;

        const parent = selectedItem.parentElement;
        if (!parent) return;

        const items = parent.querySelectorAll('.terminal-radio-item');
        items.forEach(item => {
            item.classList.remove('active');
            item.innerText = item.innerText.replace('[X]', '[ ]');
        });

        selectedItem.classList.add('active');
        selectedItem.innerText = selectedItem.innerText.replace('[ ]', '[X]');
    }

    // 获取当前选中的反馈类型
    function getSelectedAdviceType() {
        const activeItem = document.querySelector('.terminal-radio-item.active');
        return activeItem ? activeItem.getAttribute('data-value') || '其他建议' : '其他建议';
    }

    function setStatus(message, isError = false) {
        // 状态显示暂时保留，但需要新的显示方式
        console.log(message, isError ? 'ERROR' : 'INFO');
    }

    function validateMessages() {
        const nickname = elements.nickname.value.trim();
        const content = elements.content.value.trim().slice(0, MAX_CONTENT_LENGTH);

        // 清除之前的错误状态
        if (elements.nickname) elements.nickname.classList.remove('error');
        if (elements.content) elements.content.classList.remove('error');

        let hasError = false;

        if (!nickname) {
            if (elements.nickname) elements.nickname.classList.add('error');
            hasError = true;
        }

        if (!content) {
            if (elements.content) elements.content.classList.add('error');
            hasError = true;
        }

        if (hasError) {
            setStatus('REQUIRED FIELDS MISSING', true);
            return null;
        }

        return { nickname, content };
    }

    function validateAdvices() {
        const nickname = elements.advicesNickname.value.trim();
        const content = elements.advicesContent.value.trim().slice(0, 200);

        // 清除之前的错误状态
        if (elements.advicesNickname) elements.advicesNickname.classList.remove('error');
        if (elements.advicesContent) elements.advicesContent.classList.remove('error');

        let hasError = false;

        if (!nickname) {
            if (elements.advicesNickname) elements.advicesNickname.classList.add('error');
            hasError = true;
        }

        if (!content) {
            if (elements.advicesContent) elements.advicesContent.classList.add('error');
            hasError = true;
        }

        if (hasError) {
            setStatus('REQUIRED FIELDS MISSING', true);
            return null;
        }

        return { nickname, content };
    }

    function setSubmitState(nextState) {
        submitState = nextState;
        // 现在只需要更新状态，UI反馈通过showSyncFeedback显示
    }

    function clearSyncProgressTimer() {
        if (syncProgressTimer) {
            window.clearTimeout(syncProgressTimer);
            syncProgressTimer = null;
        }
        if (syncSpinnerTimer) {
            window.clearInterval(syncSpinnerTimer);
            syncSpinnerTimer = null;
        }
    }

    function startSyncProgressSimulation() {
        if (!elements?.syncBar) return;

        clearSyncProgressTimer();

        // 启动高频旋转动画 (50ms)
        syncSpinnerTimer = window.setInterval(() => {
            if (submitState === 'submitting') {
                updateSpinner(false);
            }
        }, 50);

        let progress = 0;
        const advance = () => {
            if (submitState !== 'submitting') return;

            const step = progress < 36 ? 12 : progress < 68 ? 8 : 4;
            progress = Math.min(progress + step, 88);
            
            // 使用 showSyncFeedback 统一驱动新 UI
            showSyncFeedback(elements.syncLabel.textContent, progress);

            if (progress < 88) {
                const delay = progress < 48 ? 120 : 180;
                syncProgressTimer = window.setTimeout(advance, delay);
            }
        };

        syncProgressTimer = window.setTimeout(advance, 80);
    }

    async function handleMessagesSubmit() {
        if (!elements) return;

        const now = Date.now();
        if (ENABLE_COOLDOWN && cooldownUntil > now) {
            setStatus('COOLDOWN ACTIVE', true);
            return;
        }

        const validData = validateMessages();
        if (!validData) return;

        const imageFile = elements.imageInput?.files[0];

        setSubmitState('submitting');
        showSyncFeedback('SYNCING MESSAGE', 0);
        startSyncProgressSimulation();

        try {
            const payload = buildPayload({
                nickname: validData.nickname,
                content: validData.content,
                imageFile: imageFile,
                formType: 'messages'
            });

            const result = await submitWithTimeout(payload, 'formMessages');
            clearSyncProgressTimer();
            showSyncFeedback('SYNC SUCCESS', 100);

            setTimeout(() => {
                setSubmitState('idle');
                // 重置表单并清除错误状态
                if (elements.nickname) {
                    elements.nickname.value = '';
                    elements.nickname.classList.remove('error');
                }
                if (elements.content) {
                    elements.content.value = '';
                    elements.content.classList.remove('error');
                }
                if (elements.counter) elements.counter.textContent = '00/72';
                if (elements.imageInput) elements.imageInput.value = '';
                if (elements.uploadStatus) {
                    elements.uploadStatus.innerText = "[ UPLOAD_ATTACHMENT ]";
                    elements.uploadStatus.classList.remove('ready');
                }
                currentCroppedData = null;
            }, 1500);

            if (ENABLE_COOLDOWN) cooldownUntil = Date.now() + COOLDOWN_MS;
            if (typeof refreshMessages === 'function') {
                await refreshMessages();
            }
        } catch (error) {
            console.error('Message submission failed:', error);
            setSubmitState('error');
            clearSyncProgressTimer();
            showSyncFeedback('SYNC ERROR', 0, true);
            setStatus('SYNC ERROR', true);
        } finally {
            if (submitState !== 'success') {
                setSubmitState('idle');
            }
            window.setTimeout(hideSyncFeedback, 1400);

        }
    }

    async function handleAdvicesSubmit() {
        if (!elements) return;

        const now = Date.now();
        if (ENABLE_COOLDOWN && cooldownUntil > now) {
            setStatus('COOLDOWN ACTIVE', true);
            return;
        }

        const validData = validateAdvices();
        if (!validData) return;

        const adviceType = getSelectedAdviceType();

        setSubmitState('submitting');
        showSyncFeedback('SYNCING ADVICE', 0);
        startSyncProgressSimulation();

        try {
            const payload = buildPayload({
                nickname: validData.nickname,
                content: validData.content,
                formType: 'advices',
                adviceType: adviceType
            });

            const result = await submitWithTimeout(payload, 'formAdvices');
            clearSyncProgressTimer();
            showSyncFeedback('SYNC SUCCESS', 100);

            setTimeout(() => {
                setSubmitState('idle');
                // 重置表单并清除错误状态
                if (elements.advicesNickname) {
                    elements.advicesNickname.value = '';
                    elements.advicesNickname.classList.remove('error');
                }
                if (elements.advicesContent) {
                    elements.advicesContent.value = '';
                    elements.advicesContent.classList.remove('error');
                }
                currentCroppedData = null;
            }, 1500);

            if (ENABLE_COOLDOWN) cooldownUntil = Date.now() + COOLDOWN_MS;
        } catch (error) {
            console.error('Advice submission failed:', error);
            setSubmitState('error');
            clearSyncProgressTimer();
            showSyncFeedback('SYNC ERROR', 0, true);
            setStatus('SYNC ERROR', true);
        } finally {
            if (submitState !== 'success') {
                setSubmitState('idle');
            }
            window.setTimeout(hideSyncFeedback, 1400);

        }
    }

    async function submitWithTimeout(payload, formType = 'formMessages') {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

        console.log('[Comments] 提交请求，表单类型:', formType);
        // 记录 payload 中的字段（不包括文件内容）
        for (const [key, value] of payload.entries()) {
            if (value instanceof File || value instanceof Blob) {
                console.log(`  ${key}:`, value, '大小:', value.size, '类型:', value.type);
            } else {
                console.log(`  ${key}:`, value);
            }
        }

        try {
            const response = await fetch('/submit', { // 这里的 /submit 对应 Cloudflare Functions 路径
                method: 'POST',
                headers: {
                    'form_type': formType
                },
                body: payload,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            console.log('[Comments] 响应状态:', response.status, response.statusText);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('[Comments] 服务器错误:', errorData);
                throw new Error(errorData.msg || `SERVER ERROR: ${response.status}`);
            }

            const responseData = await response.json();
            console.log('[Comments] 提交成功:', responseData);
            return responseData;
        } catch (error) {
            if (error.name === 'AbortError') {
                console.error('[Comments] 请求超时');
                throw new Error('SYNC TIMEOUT');
            }
            console.error('[Comments] 请求失败:', error);
            throw error;
        }
    }

    function updateSpinner(isFinished = false) {
        if (!elements?.syncSpinner) return;
        const frames = ['|', '/', '-', '\\'];
        if (isFinished) {
            elements.syncSpinner.textContent = '»';
            return;
        }
        const currentFrame = Math.floor(Date.now() / 100) % frames.length;
        elements.syncSpinner.textContent = frames[currentFrame];
    }

    function showSyncFeedback(label, progress, isError = false) {
        if (!elements?.syncFeedback) return;

        elements.syncFeedback.hidden = false;
        elements.syncFeedback.setAttribute('aria-hidden', 'false');
        elements.syncFeedback.classList.remove('complete'); // 重置完成状态

        if (elements.syncLabel) elements.syncLabel.textContent = label;

        // 渲染字符加载条 — 逐位生成，一对一替换 (与 1.html 完全一致)
        if (elements.syncBar) {
            const totalBlocks = 12;
            const filledCount = Math.floor((progress / 100) * totalBlocks);
            
            const blocks = [];
            for (let i = 0; i < totalBlocks; i++) {
                if (i < filledCount) {
                    blocks.push('<span class="filled">█</span>');
                } else {
                    blocks.push('<span class="empty">▓</span>');
                }
            }
            elements.syncBar.innerHTML = blocks.join(' ');
        }

        if (elements.syncPercent) {
            elements.syncPercent.textContent = `${Math.floor(progress)}%`;
        }

        // 处理 Spinner
        if (progress < 100 && !isError) {
            updateSpinner(false);
        } else if (progress >= 100) {
            updateSpinner(true);
            elements.syncFeedback.classList.add('complete');
        }

        // 设置错误状态 (全面覆盖相关元素以驱动 CSS)
        if (isError) {
            if (elements.syncBar) elements.syncBar.classList.add('error');
            if (elements.syncLabel) elements.syncLabel.classList.add('error');
            if (elements.syncSpinner) elements.syncSpinner.classList.add('error');
            if (elements.syncPercent) elements.syncPercent.classList.add('error');
        } else {
            if (elements.syncBar) elements.syncBar.classList.remove('error');
            if (elements.syncLabel) elements.syncLabel.classList.remove('error');
            if (elements.syncSpinner) elements.syncSpinner.classList.remove('error');
            if (elements.syncPercent) elements.syncPercent.classList.remove('error');
        }
    }

    function hideSyncFeedback() {
        clearSyncProgressTimer();
        if (!elements?.syncFeedback) return;
        elements.syncFeedback.hidden = true;
        elements.syncFeedback.setAttribute('aria-hidden', 'true');
        
        if (elements.syncBar) elements.syncBar.innerHTML = '';
        if (elements.syncPercent) elements.syncPercent.textContent = '0%';
        
        // 移除错误态和完成态
        elements.syncFeedback.classList.remove('complete');
        if (elements.syncBar) elements.syncBar.classList.remove('error');
        if (elements.syncLabel) elements.syncLabel.classList.remove('error');
    }

    return {
        attach,
        getStoredComments
    };
}
