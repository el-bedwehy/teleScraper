# Telegram Scraper Tampermonkey Script

This repository contains a single Tampermonkey userscript for scraping messages from Telegram Web (`web.telegram.org`).

## File

- `telegram-scraper.user.js` – main userscript. Install via Tampermonkey and run on `web.telegram.org`.

## Usage

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Add the `telegram-scraper.user.js` script.
3. Open `https://web.telegram.org` and navigate to the channel or chat you wish to scrape.
4. Use the floating panel in the bottom-right corner to start or stop scraping and to export collected messages as JSON or CSV.


The script attempts to be resilient against DOM changes and includes basic
error handling. It warns you if no channel or group is open and scrapes messages
from newest to oldest. If something goes wrong during scraping, an error message
appears in the panel. It works with both chats and channels, but may require
=======
The script attempts to be resilient against DOM changes and now includes basic
error handling. If something goes wrong during scraping, an error message will
appear in the panel. It works with both chats and channels, but may require

adjustments if Telegram updates its interface.

