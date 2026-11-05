// Screenshots of every level in test mode:  SHOTS=dir node tests/screens.mjs
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';
const SHOTS = process.env.SHOTS || '.';
const server = await serve(8127);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('http://127.0.0.1:8127/?test');
await page.click('#btn-start');
await page.waitForFunction(() => window.eyeMaze.phase === 'ready', { timeout: 60000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 3; i++) {
  await page.evaluate((i) => { window.eyeMaze.setGaze(0, 0); window.eyeMaze.jumpToLevel(i); }, i);
  await page.waitForFunction(() => window.eyeMaze.phase === 'play', { timeout: 10000 });
  await page.evaluate(() => window.eyeMaze.setGaze(0.9, 0));
  await wait(2200);
  if (i === 2) { await page.evaluate(() => window.eyeMaze.setGaze(0, 0.9)); await wait(1700); }
  await page.screenshot({ path: `${SHOTS}/level${i + 1}.png` });
}
await browser.close(); server.close();
