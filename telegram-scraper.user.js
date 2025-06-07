// ==UserScript==
// @name         Telegram Channel Scraper
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Scrape Telegram Web chats or channels from newest to oldest. Open the target conversation and click "Start Scrape". Use the export buttons to download JSON or CSV.
// @author       Anonymous
// @match        https://web.telegram.org/*
// @grant        GM_download
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    /***********************************************************************
    * Utility functions
    ***********************************************************************/

    /**
     * Sleep helper wrapped in a Promise.
     * @param {number} ms - Time in milliseconds
     */
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    /**
     * Convert array of objects to CSV string.
     * @param {Array} data
     */
    function toCSV(data) {
        if (!data.length) return '';
        const headers = Object.keys(data[0]);
        const escape = (str) => `"${String(str).replace(/"/g, '""')}"`;
        const rows = data.map(obj => headers.map(h => escape(obj[h] ?? '')).join(','));
        return headers.join(',') + '\n' + rows.join('\n');
    }

    /**
     * Display an error in the UI and log to the console.
     * @param {Error} err
     */
    function logError(err) {
        console.error('TG Scraper Error:', err);
        if (ui.progress) ui.progress.textContent = 'Error: ' + err.message;
    }

    /***********************************************************************
    * Scraper state
    ***********************************************************************/
    let scraping = false;                  // Flag indicating if scraping is active
    let messageIds = new Set();            // Track processed message IDs to avoid duplicates
    let messages = [];                     // Collected message objects
    let scrollDelay = 1500;                // Default delay between scrolls
    let ui = {};                           // Holds references to UI elements

    /***********************************************************************
    * UI helpers
    ***********************************************************************/
    function createUI() {
        // Panel container
        const panel = document.createElement('div');
        panel.id = 'tg-scrape-panel';
        panel.innerHTML = `
            <button id="tg-start-btn">Start Scrape</button>
            <button id="tg-stop-btn" disabled>Stop Scrape</button>
            <button id="tg-json-btn" disabled>Export JSON</button>
            <button id="tg-csv-btn" disabled>Export CSV</button>
            <label style="margin-left:8px;">Delay(ms): <input id="tg-delay" type="number" value="1500" style="width:80px;"/></label>
            <span id="tg-progress" style="margin-left:10px;">Ready</span>
        `;
        document.body.appendChild(panel);

        // Basic styles to blend with Telegram UI
        GM_addStyle(`
            #tg-scrape-panel { position: fixed; bottom: 10px; right: 10px; z-index: 9999; background: rgba(0,0,0,0.6); color:white; padding:8px; border-radius:4px; font-size:14px; }
            #tg-scrape-panel button { margin-right:4px; }
        `);

        // Save references
        ui.start = panel.querySelector('#tg-start-btn');
        ui.stop = panel.querySelector('#tg-stop-btn');
        ui.json = panel.querySelector('#tg-json-btn');
        ui.csv = panel.querySelector('#tg-csv-btn');
        ui.delay = panel.querySelector('#tg-delay');
        ui.progress = panel.querySelector('#tg-progress');

        // Attach listeners
        ui.start.addEventListener('click', startScraping);
        ui.stop.addEventListener('click', stopScraping);
        ui.json.addEventListener('click', exportJSON);
        ui.csv.addEventListener('click', exportCSV);
        ui.delay.addEventListener('change', () => {
            const v = parseInt(ui.delay.value, 10);
            scrollDelay = isNaN(v) ? 1500 : v;
        });
    }

    /***********************************************************************
    * Core scraping logic
    ***********************************************************************/

    /**
     * Identify the scrollable messages container element.
     * Returns the element or null if not found.
     */
function getMessageContainer() {
    // Telegram Web typically uses a scrollable div with aria-label="Message list".
    // The selector below attempts to be resilient but may need adjustment if Telegram updates its DOM.
    return document.querySelector('div[aria-label="Message list"]');
}

    /**
     * Determine if the user currently has a chat/channel open.
     * @returns {boolean}
     */
    function isInChat() {
        return Boolean(getMessageContainer());
    }

    /**
     * Extract messages from the DOM and append new entries to the global list.
     */
    function extractMessages() {
        const container = getMessageContainer();
        if (!container) return;

        // Each message container usually has data-testid="message".
        // Some channel views may use <article> elements instead, so we fall back.
        let nodes = container.querySelectorAll('div[data-testid="message"]');
        if (!nodes.length) {
            nodes = container.querySelectorAll('article');
        }
        // Process from bottom to top so array ends up ordered newest -> oldest
        Array.from(nodes).reverse().forEach(node => {
            try {
                const id = node.getAttribute('data-id') || node.id || node.dataset.messageId;
                if (!id || messageIds.has(id)) return;
                messageIds.add(id);

                // Sender name (channels may omit per-message sender)
                const senderEl = node.querySelector('[data-testid="message-author"]') || node.querySelector('header [dir]');
                const sender = senderEl ? senderEl.innerText : '';

            // Timestamp
                const timeEl = node.querySelector('time');
                const timestamp = timeEl ? timeEl.getAttribute('datetime') || timeEl.innerText : '';

            // Message text
                const text = node.querySelector('[data-testid="message-text"]')?.innerText || node.querySelector('[class*="text"]')?.innerText || '';

            // Media (collect src links from img/video tags)
                const media = [];
                node.querySelectorAll('img, video, a').forEach(el => {
                    const src = el.src || el.href;
                    if (src && !src.startsWith('blob:')) media.push(src);
                });

            // Forwarded from
                const fwd = node.querySelector('[data-testid="forwarded-from"]')?.innerText || '';

            // Reply info
                const reply = node.querySelector('[data-testid="reply-meta"]')?.innerText || '';

                messages.push({
                    id,
                    sender,
                    timestamp,
                    text,
                    media: media.join(' | '),
                    forwardedFrom: fwd,
                    replyTo: reply
                });
            } catch (err) {
                logError(err);
            }
        });
    }

    /**
     * Scroll up to load older messages.
     * @returns {Promise<boolean>} resolves to true if new content loaded, otherwise false.
     */
    async function scrollUp() {
        try {
            const container = getMessageContainer();
            if (!container) return false;
            const previousHeight = container.scrollHeight;
            container.scrollTop = 0; // Scroll to top to load more
            await sleep(100); // Give time for potential network requests
            return container.scrollHeight > previousHeight;
        } catch (err) {
            logError(err);
            return false;
        }
    }

    /**
     * Main loop for scrolling and extracting messages.
     */
    async function scrapingLoop() {
        if (!scraping) return;

        // Scroll first to load older messages
        const loadedMore = await scrollUp().catch(err => { logError(err); return false; });

        // Extract any messages currently in the DOM (newest -> oldest)
        try {
            extractMessages();
        } catch (err) {
            logError(err);
        }

        ui.progress.textContent = `Scraped ${messages.length} messages`;

        if (!loadedMore) {
            // No more messages to load; stop
            stopScraping();
            ui.progress.textContent = `Finished. Collected ${messages.length} messages`;
            return;
        }

        // Wait configured delay then continue
        await sleep(scrollDelay);
        scrapingLoop();
    }

    /** Start the scraping process */
    function startScraping() {
        if (scraping) return;
        if (!isInChat()) {
            alert('Please open a Telegram channel, community or group before scraping.');
            return;
        }
        messages = [];
        messageIds.clear();
        scrollDelay = parseInt(ui.delay.value, 10) || 1500;
        ui.start.disabled = true;
        ui.stop.disabled = false;
        ui.json.disabled = true;
        ui.csv.disabled = true;
        ui.progress.textContent = 'Scraping...';
        scraping = true;
        try {
            scrapingLoop();
        } catch (err) {
            logError(err);
        }
    }

    /** Stop the scraping process */
    function stopScraping() {
        if (!scraping) return;
        scraping = false;
        ui.start.disabled = false;
        ui.stop.disabled = true;
        ui.json.disabled = messages.length === 0;
        ui.csv.disabled = messages.length === 0;
    }

    /** Export collected messages as JSON */
    function exportJSON() {
        const blob = new Blob([JSON.stringify(messages, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        GM_download({ url, name: 'telegram_messages.json' });
    }

    /** Export collected messages as CSV */
    function exportCSV() {
        const csv = toCSV(messages);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        GM_download({ url, name: 'telegram_messages.csv' });
    }

    /***********************************************************************
    * Initialize
    ***********************************************************************/
    try {
        createUI();
    } catch (err) {
        logError(err);
    }

    // Catch unhandled errors
    window.addEventListener('error', (e) => logError(e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => logError(e.reason));
})();

