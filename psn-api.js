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

// Target URLs to monitor
const TARGET_URLS = [
  "https://web.np.playstation.com/api/graphql/v1/op?operationName=getProfileOracle",
  "https://web.np.playstation.com/api/graphql/v1/op?operationName=getPurchasedGameList",
  "https://web.np.playstation.com/api/graphql/v1/op?operationName=queryOracleUserProfileFullSubscription",
  "https://web.np.playstation.com/api/graphql/v1/op?operationName=getUserDevices",
  "https://accounts.api.playstation.com/api/v1/accounts/me/communication",
  /\/twostepbackupcodes$/,
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

// این تابع جدید اضافه شده
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
  console.log("operationName === ", operationName);

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
      console.log(
        "majid ======",
        responseData.data?.deviceStorageDetailsRetrieve
      );

      if (responseData.data?.deviceStorageDetailsRetrieve) {
        finalResponses.devices =
          responseData.data.deviceStorageDetailsRetrieve.map((item) => ({
            name: item.deviceName,
            platform: item.devicePlatform,
          }));
      }
      break;

    case "twostepbackupcodes":
      console.log("responseData =-= ", responseData);

      if (responseData.backup_codes) {
        finalResponses.backupCodes = responseData.backup_codes.map(
          (item) => item.code
        );
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

  // Set proxy if provided
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
 * Parse proxy data from a string
 * @param {string} proxyData - Proxy data in format host:port:username:password
 * @returns {Object|null} Parsed proxy object or null if invalid
 */
function parseProxy(proxyData) {
  if (!proxyData) return null;

  const lines = proxyData.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;

  // Use the first proxy in the file
  const proxyLine = lines[0].trim();

  // Check for Lightning Proxies format (host:port:username:password)
  if (proxyLine.split(":").length === 4) {
    const [host, port, username, password] = proxyLine.split(":");
    return {
      host,
      port,
      username,
      password,
      url: `http://${username}:${password}@${host}:${port}`,
    };
  }

  // Check for standard URL format
  try {
    const url = new URL(proxyLine);
    const protocol = url.protocol.replace(":", "");
    return {
      host: url.hostname,
      port: url.port,
      username: url.username,
      password: url.password,
      protocol,
      url: proxyLine,
    };
  } catch (e) {
    // If it's not a valid URL, try host:port format
    const parts = proxyLine.split(":");
    if (parts.length === 2) {
      return {
        host: parts[0],
        port: parts[1],
        protocol: "http",
        url: `http://${parts[0]}:${parts[1]}`,
      };
    }
  }

  return null;
}

/**
 * Run the PlayStation API tool with the provided credentials
 * @param {Object} options - Tool options
 * @param {string} options.email - User email
 * @param {string} options.password - User password
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
    email,
    password,
    npsso,
    proxyFile,
    proxyData,
    onProgress = () => {},
    onData = () => {},
    onComplete = () => {},
    onError = () => {},
  } = options;

  // Create a new object to store responses
  let finalResponses = {};

  // Parse proxy if provided
  let proxyConfig = null;
  if (proxyData) {
    proxyConfig = parseProxy(proxyData);
    if (proxyConfig) {
      onProgress(`Using proxy: ${proxyConfig.host}:${proxyConfig.port}`);
    }
  }

  // Browser launch options
  const browserOptions = {
    executablePath: "/home/majid/Documents/chrome-linux/chrome",
    headless: false, // Run headless in production
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };

  // Add proxy args if configured
  if (proxyConfig) {
    browserOptions.args.push(
      `--proxy-server=${proxyConfig.host}:${proxyConfig.port}`
    );
  }

  let browser;
  try {
    // Launch browser
    onProgress("Launching browser...");
    browser = await puppeteer.launch(browserOptions);

    // Setup first page
    const page1 = await createConfiguredPage(
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

    // try {
    //   onProgress('Attempting to click on the specified element...');
    //   await page1.waitForXPath('/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[1]/ul/li[2]/div', { timeout: 10000 });
    //   const [element] = await page1.$x('/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[1]/ul/li[2]/div');

    //   if (element) {
    //     onProgress('Element found. Clicking...');
    //     await element.click();
    //     onProgress('Click successful.');

    //     // Wait after click to allow any actions to complete
    //     await wait(3000, 'after clicking the element', onProgress);

    //     // کد جدید برای کلیک دوم با XPath اصلاح شده
    //     // Wait for navigation after first click
    //     onProgress('Waiting for navigation after first click...');
    //     try {
    //       // Wait for potential navigation to complete
    //       await page1.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {
    //         onProgress('No navigation occurred or navigation already completed.');
    //       });

    //       // Wait a bit for the new page to stabilize
    //       await wait(5000, 'for the new page to stabilize after navigation', onProgress);

    //       // Now try to find and click the element with the specified XPath
    //       onProgress('Attempting to find and click on element with XPath: //*[@id="ember138"]/div/div/div/div[1]/div');

    //       // Wait for the element to be available in the DOM
    //       await page1.waitForXPath('//*[@id="ember138"]/div/div/div/div[1]/div', { timeout: 15000 }).catch(e => {
    //         onProgress(`Element with specified XPath not found in time: ${e.message}`);
    //       });

    //       // Try to find the element
    //       const [secondElement] = await page1.$x('/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[3]/div/div/div/div/div/main/div/div/div[2]/div[1]/ul[3]/li[3]/button/div/div/div/div[1]/div');

    //       if (secondElement) {
    //         onProgress('Found element with specified XPath. Clicking...');
    //         await secondElement.click();
    //         onProgress('Successfully clicked on the second element.');

    //         // Wait after second click to allow any actions to complete
    //         await wait(5000, 'after clicking the second element', onProgress);
    //       } else {
    //         onProgress('Element with specified XPath not found. Continuing with the process.');
    //       }
    //     } catch (error) {
    //       onProgress(`Error while handling second click: ${error.message}`);
    //       // Continue with the process even if this step fails
    //     }
    //   } else {
    //     onProgress('Element not found with the specified XPath.');
    //   }
    // } catch (error) {
    //   onProgress(`Error while trying to click the element: ${error.message}`);
    // }

    console.log("finalResponses ======> ", finalResponses);

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
    console.log("xxxxxxxxx ----", allCookies);

    // Setup first page
    const page11 = await createConfiguredPage(
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
    await navigateToPage(
      page11,
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

    await wait(
      5000,
      "for the new page to stabilize after navigation",
      onProgress
    );

    // اضافه کردن مراحل جدید قبل از رفتن به صفحه دوم
    try {
      // کلیک روی المان اول جدید
      onProgress("Attempting to click on first new element...");
      const xxxx = await page11.waitForXPath(
        "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[2]/ul/li[8]/div/button",
        { timeout: 10000 }
      );
      const [elTransaction] = await xxxx.$x(
        "/html/body/div[3]/div/div[2]/div/div/div/div[2]/div/div[2]/div/div/ul/li[2]/ul/li[8]/div/button"
      );

      if (elTransaction) {
        await elTransaction.click();

        await wait(
          20000,
          "for the new page to stabilize after navigation",
          onProgress
        );

        const [firstNewElement] = await page11.$x(
          "/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div[3]/div[3]/main/div/div[4]/div[3]/button"
        );

        if (firstNewElement) {
          await wait(20000, "after clicking first new element", onProgress); // 5 ثانیه صبر

          // Wait for the date input element to be available
          await page1
            .waitForSelector("#ember8", { timeout: 10000 })
            .catch((e) => {
              onProgress(
                `Date input field with ID ember8 not found in time: ${e.message}`
              );
            });

          // Try to find the date input element
          const dateInput = await page1.$("#ember8");

          if (dateInput) {
            onProgress("Found date input field. Setting date value...");

            // Get current date to use as default or set a specific date
            const today = new Date();
            const month = String(today.getMonth() + 1).padStart(2, "0"); // Months are 0-indexed
            const day = String(today.getDate()).padStart(2, "0");
            const year = today.getFullYear();

            // Format as MM/DD/YYYY
            const dateValue = `${month}/${day}/${year}`;

            // For HTML date inputs, we need to use YYYY-MM-DD format for the value attribute
            // but we'll also try the MM/DD/YYYY format for display
            const htmlDateValue = `${year}-${month}-${day}`;

            // Try multiple approaches to set the date

            // Approach 1: Direct property setting
            await page1.evaluate(
              (selector, value) => {
                const element = document.querySelector(selector);
                if (element) {
                  element.value = value;
                  // Trigger change event to ensure the application recognizes the change
                  const event = new Event("change", { bubbles: true });
                  element.dispatchEvent(event);
                }
              },
              "#ember8",
              htmlDateValue
            );
          }
        } else {
          onProgress("First new element not found.");
        }
      }

      // // کلیک روی المان دوم جدید
      // onProgress('Attempting to click on second new element...');
      // await page1.waitForXPath('/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div[3]/div[3]/main/div/div[4]/div[3]', { timeout: 10000 });
      // const [secondNewElement] = await page1.$x('/html/body/div[3]/div/div[2]/div/div/div/div[3]/div/div/div[3]/div[3]/main/div/div[4]/div[3]');

      // if (secondNewElement) {
      //   onProgress('Second new element found. Clicking...');
      //   await secondNewElement.click();
      //   onProgress('Second new element clicked successfully.');
      //   await wait(7000, 'after clicking second new element', onProgress); // 7 ثانیه صبر
      // } else {
      //   onProgress('Second new element not found.');
      // }
    } catch (error) {
      onProgress(`Error during new steps: ${error.message}`);
    }

    onProgress(`Combined unique cookies: ${allCookies.length}`);

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
      creditCards: creditCards.data.creditCards,
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

    onProgress("Opening PlayStation Store Latest page...");
    const page3 = await createConfiguredPage(
      browser,
      allCookies,
      npsso,
      TARGET_URLS,
      finalResponses,
      "page3",
      onProgress,
      onData,
      proxyConfig
    );

    await navigateToPage(
      page3,
      "https://store.playstation.com/en-us/pages/latest",
      "PlayStation Store Latest page",
      onProgress
    );

    await wait(10000, "for PlayStation Store page to fully load", onProgress);

    const storePageCookies = await page3.cookies();
    onProgress(
      `Retrieved ${storePageCookies.length} cookies from the PlayStation Store page`
    );

    const updatedAllCookies = combineUniqueCookies(
      allCookies,
      storePageCookies
    );
    onProgress(`Updated combined unique cookies: ${updatedAllCookies.length}`);

    const backups = await axios.get(
      "https://ca.account.sony.com/api/v1/user/accounts/6928868522581896841/twostepbackupcodes",
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
      backupCodes: backups.data.backup_codes.map((item) => item.code),
    };

    const transactions = await axios({
      method: "GET",
      url: "https://web.np.playstation.com/api/graphql/v1/transact/transaction/history",
      headers: {
        Cookie: updatedAllCookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; "),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      data: {
        query:
          "query GetTransactionHistory($input: TransactionHistoryInput!) { transactionHistory(input: $input) { ...fields } }",
        variables: {
          input: {
            limit: 100,
            startDate: "2010-05-05T00:00:00.000+0430",
            endDate: "2025-04-05T23:59:59.999+0330",
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
            ],
          },
        },
      },
    });

    console.log(transactions);

    finalResponses = {
      ...finalResponses,
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
          )[0];
          return `${t.additionalInfo.orderItems[0].productName} [${
            t.additionalInfo.orderItems[0].totalPrice.formattedValue
          }] | [ ${formattedSkuId} ] | [ ${
            new Date(t.transactionDetail.transactionDate).getMonth() + 1
          }/${new Date(
            t.transactionDetail.transactionDate
          ).getDate()}/${new Date(
            t.transactionDetail.transactionDate
          ).getFullYear()} ]`;
        })
        .join("\n"),
    };

    const pythonProcess = spawn("python3", ["get_devices.py", npssoValue]);

    let result = "";
    let error = "";

    pythonProcess.stdout.on("data", (data) => {
      result += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
      error += data.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code !== 0) {
        console.error(`خطا در اجرای پایتون:`, error);
        return;
      }

      try {
        const devices = JSON.parse(result);
        finalResponses = {
          ...finalResponses,
          newDevices: devices,
        };
        console.log("Devices:", devices);
      } catch (e) {
        console.error("خطا در تبدیل خروجی:", e);
        console.log("خروجی خام:", result);
      }
    });

    console.log("xxxx [] ===> ", finalResponses);

    // Process completed successfully
    onProgress("Processing completed successfully");
    onComplete(finalResponses);
  } catch (error) {
    onProgress(`Error occurred: ${error.message}`);
    onError(error);
  } finally {
    // Close the browser
    if (browser) {
      // await browser.close();
      onProgress("Browser closed.");
    }
  }
}

module.exports = { runPsnApiTool };
