/**
 * PlayStation API Tool - Server
 *
 * Express server with SSR using EJS for PlayStation API interaction
 */

const express = require("express");
const path = require("path");
const fileUpload = require("express-fileupload");
const fs = require("fs").promises;
const http = require("http");
const socketIo = require("socket.io");
const { runPsnApiTool, testProxy } = require("./psn-api");
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// مسیر فایل پسورد
const PASSWORD_FILE_PATH = path.join(__dirname, 'data', 'password.json');

// تابع بارگذاری اطلاعات پسورد
async function loadPasswordData() {
  try {
    const data = await fs.readFile(PASSWORD_FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading password data:', error);
    // در صورت عدم وجود فایل، یک پسورد پیش‌فرض ایجاد می‌کنیم
    const defaultPassword = 'admin123';
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto
      .createHmac('sha256', salt)
      .update(defaultPassword)
      .digest('hex');

    const passwordData = { hash, salt };

    // ایجاد دایرکتوری data اگر وجود نداشته باشد
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });

    // ذخیره پسورد پیش‌فرض
    await fs.writeFile(PASSWORD_FILE_PATH, JSON.stringify(passwordData, null, 2), 'utf8');

    console.log('Default password created: admin123');
    return passwordData;
  }
}

// تابع بررسی اعتبار پسورد
function verifyPassword(inputPassword, storedHash, storedSalt) {
  const inputHash = crypto
    .createHmac('sha256', storedSalt)
    .update(inputPassword)
    .digest('hex');

  return inputHash === storedHash;
}

async function loadOrCreateCookieSecret() {
  const secretFilePath = path.join(__dirname, 'data', 'cookie-secret.json');

  try {
    // سعی می‌کنیم فایل موجود را بخوانیم
    const data = await fs.readFile(secretFilePath, 'utf8');
    const secretData = JSON.parse(data);
    return secretData.secret;
  } catch (error) {
    // اگر فایل وجود نداشت، یک کلید جدید ایجاد می‌کنیم
    const newSecret = crypto.randomBytes(32).toString('hex');

    // اطمینان از وجود دایرکتوری data
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });

    // ذخیره کلید جدید
    await fs.writeFile(secretFilePath, JSON.stringify({ secret: newSecret }, null, 2), 'utf8');

    console.log('New cookie secret created and saved');
    return newSecret;
  }
}

// تغییر تنظیمات احراز هویت برای استفاده از کلید ذخیره شده
let AUTH_CONFIG = {
  username: 'admin', // نام کاربری ثابت
  cookieName: 'psn_api_auth',
  cookieMaxAge: 30 * 24 * 60 * 60 * 1000 // 30 روز
};

async function parseAccountFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const accounts = [];
    const entries = content.split('-----------------------------------------------------------------------');

    for (const entry of entries) {
      const lines = entry.split('\n').filter(line => line.trim() !== '');
      if (lines.length >= 2) {
        const credentialsMatch = lines[0].match(/Email:pass\s*:(.+)/i);
        const npssoMatch = lines[1].match(/Npsso\s*:(.+)/i);

        if (credentialsMatch && npssoMatch) {
          const credentials = credentialsMatch[1].trim();
          const npsso = npssoMatch[1].trim();
          if (credentials.includes(':')) {
            accounts.push({ credentials, npsso });
          }
        }
      }
    }

    return accounts;
  } catch (error) {
    console.error('Error parsing account file:', error);
    throw new Error('Failed to parse account file');
  }
}

// بارگذاری یا ایجاد کلید رمزنگاری کوکی در زمان راه‌اندازی سرور
(async function initializeAuth() {
  try {
    AUTH_CONFIG.cookieSecret = await loadOrCreateCookieSecret();
    console.log('Cookie secret loaded successfully');
  } catch (error) {
    console.error('Error loading cookie secret:', error);
    // در صورت خطا، یک کلید موقت ایجاد می‌کنیم
    AUTH_CONFIG.cookieSecret = crypto.randomBytes(32).toString('hex');
    console.warn('Using temporary cookie secret - all users will need to login again');
  }
})();

// اضافه کردن به بالای فایل server.js، بعد از تعریف activeJobs
const activeBatches = new Map();

// Set up EJS as the view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(
  fileUpload({
    createParentPath: true,
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB max file size
    },
  })
);

// تابع برای تجزیه فایل حاوی اکانت‌ها
async function parseAccountsFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const sections = content.split('-----------------------------------------------------------------------');

    const accounts = [];

    for (const section of sections) {
      const trimmedSection = section.trim();
      if (!trimmedSection) continue;

      const lines = trimmedSection.split('\n');
      let credentials = '';
      let npsso = '';

      for (const line of lines) {
        if (line.startsWith('Email:pass :')) {
          credentials = line.replace('Email:pass :', '').trim();
        } else if (line.startsWith('Npsso :')) {
          npsso = line.replace('Npsso :', '').trim();
        }
      }

      if (credentials && npsso) {
        accounts.push({ credentials, npsso });
      }
    }

    return accounts;
  } catch (error) {
    console.error('Error parsing accounts file:', error);
    throw error;
  }
}


// تابع بررسی اعتبار کوکی
function validateAuthCookie(req) {
  const authCookie = req.cookies[AUTH_CONFIG.cookieName];

  if (!authCookie) {
    return false;
  }

  try {
    const [timestamp, hash] = authCookie.split('|');

    // بررسی اعتبار هش
    const expectedHash = crypto
      .createHmac('sha256', AUTH_CONFIG.cookieSecret)
      .update(timestamp + AUTH_CONFIG.username)
      .digest('hex');

    // بررسی تطابق هش و عدم منقضی شدن کوکی
    const isValidHash = hash === expectedHash;

    // اگر remember me انتخاب نشده بود، کوکی بعد از بستن مرورگر منقضی می‌شود
    // در اینجا نیازی به بررسی زمان نیست چون مرورگر خودش کوکی‌های session را مدیریت می‌کند

    return isValidHash;
  } catch (error) {
    console.error('Auth cookie validation error:', error);
    return false;
  }
}

// میدلور بررسی احراز هویت
function requireAuth(req, res, next) {
  if (validateAuthCookie(req)) {
    next();
  } else {
    res.redirect('/login');
  }
}

// میدلور هدایت کاربران احراز هویت شده
function redirectIfAuthenticated(req, res, next) {
  if (validateAuthCookie(req)) {
    res.redirect('/');
  } else {
    next();
  }
}

// Store active jobs
const activeJobs = new Map();

// Path for the proxy database file
const PROXY_DB_PATH = path.join(__dirname, "data", "proxies.txt");

// Socket.io connection
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// Ensure data directory exists
async function ensureDataDirectory() {
  const dataDir = path.join(__dirname, "data");
  try {
    await fs.mkdir(dataDir, { recursive: true });
    // Create proxy database file if it doesn't exist
    try {
      await fs.access(PROXY_DB_PATH);
    } catch (error) {
      // File doesn't exist, create it
      await fs.writeFile(PROXY_DB_PATH, "", "utf8");
      console.log("Created proxy database file");
    }
  } catch (error) {
    console.error("Error ensuring data directory:", error);
  }
}

async function addProxiesToDatabase(proxies) {
  try {
    // Read existing proxies
    let existingContent = "";
    try {
      existingContent = await fs.readFile(PROXY_DB_PATH, "utf8");
    } catch (error) {
      // File might not exist yet
      console.log("Proxy database file not found, will create new");
    }

    const existingProxies = new Set(
      existingContent.split("\n").filter((line) => line.trim() !== "")
    );

    // Add new proxies
    let addedCount = 0;
    for (const proxy of proxies) {
      if (proxy.trim() !== "" && !existingProxies.has(proxy)) {
        existingProxies.add(proxy);
        addedCount++;
      }
    }

    // Write back to file
    await fs.writeFile(
      PROXY_DB_PATH,
      Array.from(existingProxies).join("\n"),
      "utf8"
    );

    return {
      totalProxies: existingProxies.size,
      addedProxies: addedCount,
    };
  } catch (error) {
    console.error("Error adding proxies to database:", error);
    throw error;
  }
}

// Get a random proxy from database and remove it
async function getAndRemoveRandomProxy() {
  try {
    // Read existing proxies
    let existingContent = '';
    try {
      existingContent = await fs.readFile(PROXY_DB_PATH, 'utf8');
    } catch (error) {
      return null;
    }

    const proxies = existingContent.split('\n').filter(line => line.trim() !== '');
    if (proxies.length === 0) return null;

    // Get a random proxy
    const randomIndex = Math.floor(Math.random() * proxies.length);
    const selectedProxy = proxies[randomIndex];

    // Remove the selected proxy from the list
    proxies.splice(randomIndex, 1);

    // Write back to file
    await fs.writeFile(PROXY_DB_PATH, proxies.join('\n'), 'utf8');

    return selectedProxy;
  } catch (error) {
    console.error('Error getting random proxy:', error);
    return null;
  }
}


// مسیر صفحه لاگین
app.get('/login', redirectIfAuthenticated, (req, res) => {
  res.render('login', {
    error: req.query.error || null
  });
});

// پردازش فرم لاگین
// پردازش فرم لاگین
app.post('/login', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;

    // بارگذاری اطلاعات پسورد
    const passwordData = await loadPasswordData();

    // بررسی اعتبار نام کاربری و رمز عبور
    if (username === AUTH_CONFIG.username &&
      verifyPassword(password, passwordData.hash, passwordData.salt)) {

      // ایجاد کوکی احراز هویت
      const timestamp = Date.now().toString();
      const hash = crypto
        .createHmac('sha256', AUTH_CONFIG.cookieSecret)
        .update(timestamp + username)
        .digest('hex');

      // تنظیم کوکی
      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
      };

      // اگر "مرا به خاطر بسپار" انتخاب شده باشد، زمان انقضا تنظیم می‌شود
      if (rememberMe === 'on') {
        cookieOptions.maxAge = AUTH_CONFIG.cookieMaxAge;
      }

      res.cookie(AUTH_CONFIG.cookieName, `${timestamp}|${hash}`, cookieOptions);

      // هدایت به صفحه اصلی
      res.redirect('/');
    } else {
      // خطای لاگین
      res.redirect('/login?error=Invalid%20username%20or%20password');
    }
  } catch (error) {
    console.error('Login error:', error);
    res.redirect('/login?error=An%20error%20occurred%20during%20login');
  }
});

// مسیر خروج
app.get('/logout', (req, res) => {
  res.clearCookie(AUTH_CONFIG.cookieName);
  res.redirect('/login');
});


// Routes
app.get("/", requireAuth, (req, res) => {
  res.render("index", { title: "PlayStation API Tool" });
});

app.post('/run-tool', requireAuth, async (req, res) => {
  try {
    const { inputMethod, credentials, npsso, useProxy } = req.body;
    let proxyFile = null;
    let proxyData = null;
    let selectedProxy = null;
    let accounts = [];

    // Check if it's batch processing or single account
    if (inputMethod === 'batch' && req.files && req.files.accountFile) {
      const uploadedFile = req.files.accountFile;
      const uploadDir = path.join(__dirname, 'uploads');
      await fs.mkdir(uploadDir, { recursive: true });
      const filePath = path.join(uploadDir, uploadedFile.name);
      await uploadedFile.mv(filePath);

      // Parse the account file
      accounts = await parseAccountFile(filePath);
      if (accounts.length === 0) {
        throw new Error('No valid accounts found in the uploaded file.');
      }
      console.log(`Found ${accounts.length} accounts in the file.`);
    } else {
      // Single account processing
      if (!credentials || !credentials.includes(':')) {
        throw new Error('Invalid credentials format. Please use email:password format.');
      }
      accounts.push({ credentials, npsso });
    }

    console.log('Received request with', accounts.length, 'account(s)');
    console.log('Use proxy:', useProxy === 'true' ? 'Yes' : 'No');

    // Check if proxy file was uploaded
    if (req.files && req.files.proxyFile) {
      const uploadedFile = req.files.proxyFile;
      const uploadDir = path.join(__dirname, 'uploads');
      await fs.mkdir(uploadDir, { recursive: true });
      const filePath = path.join(uploadDir, uploadedFile.name);
      await uploadedFile.mv(filePath);
      proxyData = await fs.readFile(filePath, 'utf8');
      console.log('Proxy file loaded:', uploadedFile.name);

      const proxies = proxyData.split('\n').filter(line => line.trim() !== '');
      const dbResult = await addProxiesToDatabase(proxies);
      console.log(`Added ${dbResult.addedProxies} new proxies to database. Total proxies: ${dbResult.totalProxies}`);
      proxyFile = filePath;
    }

    // Proxy selection logic (same as before)
    let workingProxy = null;
    if (useProxy === 'true') {
      let proxyTestAttempts = 0;
      const maxProxyTestAttempts = 5;
      while (!workingProxy && proxyTestAttempts < maxProxyTestAttempts) {
        proxyTestAttempts++;
        console.log(`Proxy test attempt ${proxyTestAttempts} of ${maxProxyTestAttempts}`);
        selectedProxy = await getAndRemoveRandomProxy();
        if (!selectedProxy) {
          console.log('No proxies available in database');
          break;
        }
        console.log(`Testing proxy: ${selectedProxy}`);
        const httpsResult = await testProxy(selectedProxy, 'https');
        if (httpsResult.success) {
          workingProxy = { proxy: selectedProxy, protocol: 'https' };
          console.log(`Found working HTTPS proxy: ${selectedProxy}`);
          break;
        }
        const socks5Result = await testProxy(selectedProxy, 'socks5');
        if (socks5Result.success) {
          workingProxy = { proxy: selectedProxy, protocol: 'socks5' };
          console.log(`Found working SOCKS5 proxy: ${selectedProxy}`);
          break;
        }
        console.log(`Proxy ${selectedProxy} failed both HTTPS and SOCKS5 tests`);
      }
      if (workingProxy) {
        proxyData = workingProxy.proxy;
        console.log(`Using working proxy: ${proxyData} (${workingProxy.protocol})`);
      } else {
        console.log('No working proxies found. Continuing without proxy.');
      }
    } else {
      console.log('Proxy usage disabled by user. Continuing without proxy.');
    }

    // Generate a unique job ID
    const jobId = Date.now().toString();
    console.log('Generated job ID:', jobId);

    // Create a socket room for this job
    const roomName = `job-${jobId}`;

    // Store job info (modified for batch processing)
    activeJobs.set(jobId, {
      status: 'running',
      startTime: new Date(),
      accounts,
      currentAccountIndex: 0,
      results: [],
      errors: [],
      failedAccounts: [] // برای ذخیره اکانت‌های ناموفق
    });

    // Render the result page immediately
    res.render('result', {
      title: 'Processing Request',
      jobId,
      initialStatus: 'running'
    });

    // Process accounts one by one
    setTimeout(() => {
      console.log('Starting account processing for job:', jobId);
      processAccounts(jobId, accounts, {
        proxyData: workingProxy ? proxyData : null,
        proxyProtocol: workingProxy ? workingProxy.protocol : null,
        onProgress: (message) => {
          console.log(`[${jobId}] Progress:`, message);
          io.to(roomName).emit('progress', { message });
        },
        onData: (data) => {
          console.log(`[${jobId}] Data update`);
          io.to(roomName).emit('data', { data });
        },
        onComplete: (results) => {
          console.log(`[${jobId}] Complete for an account`);
          const job = activeJobs.get(jobId);
          const updatedJob = {
            ...job,
            results: [...job.results, results],
            currentAccountIndex: job.currentAccountIndex + 1
          };
          activeJobs.set(jobId, updatedJob);

          io.to(roomName).emit('accountComplete', { results, index: job.currentAccountIndex });

          if (updatedJob.currentAccountIndex < job.accounts.length) {
            // Process next account
            processNextAccount(jobId);
          } else {
            // All accounts processed
            activeJobs.set(jobId, {
              ...updatedJob,
              status: 'completed',
              endTime: new Date()
            });
            // اگر اکانت‌های ناموفق وجود داشته باشه، فایلش رو می‌سازیم
            if (updatedJob.failedAccounts.length > 0) {
              const failedAccountsFilePath = createFailedAccountsFile(jobId, updatedJob.failedAccounts);
              io.to(roomName).emit('complete', {
                results: updatedJob.results,
                failedAccountsFilePath
              });
            } else {
              io.to(roomName).emit('complete', { results: updatedJob.results });
            }
          }
        },
        onError: (error, accountIndex) => {
          console.error(`[${jobId}] Error for account ${accountIndex}:`, error);
          const job = activeJobs.get(jobId);
          const failedAccount = job.accounts[accountIndex]; // ذخیره اکانت ناموفق
          const updatedJob = {
            ...job,
            errors: [...job.errors, { accountIndex, error: error.message }],
            failedAccounts: [...job.failedAccounts, failedAccount], // اضافه کردن اکانت به لیست ناموفق‌ها
            currentAccountIndex: job.currentAccountIndex + 1
          };
          activeJobs.set(jobId, updatedJob);

          // ارسال اطلاعات اکانت همراه با خطا به کلاینت
          console.log(`Sending error data for account ${accountIndex}:`, {
            error: error.message,
            index: accountIndex,
            credentials: failedAccount.credentials,
            npsso: failedAccount.npsso
          });
          io.to(roomName).emit('accountError', {
            error: error.message,
            index: accountIndex,
            credentials: failedAccount.credentials,
            npsso: failedAccount.npsso
          });

          if (updatedJob.currentAccountIndex < job.accounts.length) {
            // Process next account
            processNextAccount(jobId);
          } else {
            // All accounts processed (with errors)
            activeJobs.set(jobId, {
              ...updatedJob,
              status: 'completed_with_errors',
              endTime: new Date()
            });
            // اگر اکانت‌های ناموفق وجود داشته باشه، فایلش رو می‌سازیم
            if (updatedJob.failedAccounts.length > 0) {
              const failedAccountsFilePath = createFailedAccountsFile(jobId, updatedJob.failedAccounts);
              io.to(roomName).emit('complete', {
                results: updatedJob.results,
                errors: updatedJob.errors,
                failedAccountsFilePath
              });
            } else {
              io.to(roomName).emit('complete', {
                results: updatedJob.results,
                errors: updatedJob.errors
              });
            }
          }
        }
      });
    }, 1000);

  } catch (error) {
    console.error('Error processing request:', error);
    res.render('error', {
      title: 'Error',
      message: error.message
    });
  }
});

// تابع برای ساخت فایل اکانت‌های ناموفق
function createFailedAccountsFile(jobId, failedAccounts) {
  try {
    const outputDir = path.join(__dirname, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0]; // فرمت تاریخ: YYYY-MM-DD
    const fileName = `failed-accounts-${jobId}-${date}.txt`;
    const filePath = path.join(outputDir, fileName);

    // ساخت محتوای فایل با فرمت مشابه ورودی
    let content = '';
    failedAccounts.forEach((account, index) => {
      content += `Email:pass : ${account.credentials}\n`;
      content += `Npsso : ${account.npsso}\n`;
      if (index < failedAccounts.length - 1) {
        content += '-----------------------------------------------------------------------\n';
      }
    });

    // نوشتن محتوا توی فایل
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Failed accounts file created: ${fileName}`);
    return filePath;
  } catch (error) {
    console.error('Error creating failed accounts file:', error);
    return null;
  }
}

// Function to process accounts one by one
function processAccounts(jobId, accounts, options) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  const account = accounts[job.currentAccountIndex];
  console.log(`Processing account ${job.currentAccountIndex + 1}/${accounts.length}: ${account.credentials}`);

  runPsnApiTool({
    credentials: account.credentials,
    npsso: account.npsso,
    proxyData: options.proxyData,
    proxyProtocol: options.proxyProtocol,
    onProgress: options.onProgress,
    onData: options.onData,
    onComplete: (results) => {
      options.onComplete({ ...results, credentials: account.credentials });
    },
    onError: (error) => {
      options.onError(error, job.currentAccountIndex);
    }
  });
}

// Function to process the next account
function processNextAccount(jobId) {
  const job = activeJobs.get(jobId);
  if (!job || job.currentAccountIndex >= job.accounts.length) return;

  console.log(`Moving to next account: ${job.currentAccountIndex + 1}/${job.accounts.length}`);
  io.to(`job-${jobId}`).emit('progress', { message: `Processing account ${job.currentAccountIndex + 1} of ${job.accounts.length}` });
  processAccounts(jobId, job.accounts, {
    proxyData: job.proxyData,
    proxyProtocol: job.proxyProtocol,
    onProgress: (message) => io.to(`job-${jobId}`).emit('progress', { message }),
    onData: (data) => io.to(`job-${jobId}`).emit('data', { data }),
    onComplete: (results) => {
      job.results.push(results);
      job.currentAccountIndex++;
      io.to(`job-${jobId}`).emit('accountComplete', { results, index: job.currentAccountIndex - 1 });
      if (job.currentAccountIndex < job.accounts.length) {
        processNextAccount(jobId);
      } else {
        job.status = 'completed';
        job.endTime = new Date();
        io.to(`job-${jobId}`).emit('complete', { results: job.results });
      }
    },
    onError: (error, accountIndex) => {
      job.errors.push({ accountIndex, error: error.message });
      job.currentAccountIndex++;
      io.to(`job-${jobId}`).emit('accountError', { error: error.message, index: accountIndex });
      if (job.currentAccountIndex < job.accounts.length) {
        processNextAccount(jobId);
      } else {
        job.status = 'completed_with_errors';
        job.endTime = new Date();
        io.to(`job-${jobId}`).emit('complete', { results: job.results, errors: job.errors });
      }
    }
  });
}

// API endpoint to get job status
app.get("/api/job/:jobId", requireAuth, (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json(job);
});

// Join a job room for real-time updates
app.post("/api/job/:jobId/join", requireAuth, (req, res) => {
  const { jobId } = req.params;
  const { socketId } = req.body;

  if (!socketId) {
    return res.status(400).json({ error: "Socket ID is required" });
  }

  const socket = io.sockets.sockets.get(socketId);
  if (!socket) {
    return res.status(404).json({ error: "Socket not found", socketId });
  }

  const roomName = `job-${jobId}`;
  socket.join(roomName);

  console.log(`Socket ${socketId} joined room ${roomName}`);

  // Send an initial message to ensure proper functioning
  socket.emit("progress", { message: "Connected to server." });

  res.json({ success: true, room: roomName });
});

// API endpoint for proxy testing
app.post("/api/test-proxy", requireAuth, async (req, res) => {
  try {
    const { proxy } = req.body;

    // Implement proxy testing logic here
    // This is a placeholder that simulates proxy testing
    const testResult = {
      proxy,
      valid: Math.random() > 0.3, // Simulate 70% success rate
      protocol: proxy.includes("socks5") ? "SOCKS5" : "HTTP",
      ip: "123.45.67.89", // Simulated IP
      responseTime: Math.floor(Math.random() * 500) + 100, // Random response time between 100-600ms
    };

    setTimeout(() => {
      res.json(testResult);
    }, 500); // Simulate network delay
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to upload proxies
app.post("/api/upload-proxies", requireAuth, async (req, res) => {
  try {
    if (!req.files || !req.files.proxyFile) {
      return res.status(400).json({ error: "No proxy file uploaded" });
    }

    const uploadedFile = req.files.proxyFile;
    const proxyData = uploadedFile.data.toString("utf8");
    const proxies = proxyData.split("\n").filter((line) => line.trim() !== "");

    // Add to database
    const result = await addProxiesToDatabase(proxies);

    res.json({
      success: true,
      message: `Added ${result.addedProxies} new proxies. Total proxies in database: ${result.totalProxies}`,
      ...result,
    });
  } catch (error) {
    console.error("Error uploading proxies:", error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get all proxies
app.get("/api/proxies", requireAuth, async (req, res) => {
  try {
    let proxies = [];
    try {
      const content = await fs.readFile(PROXY_DB_PATH, "utf8");
      proxies = content.split("\n").filter((line) => line.trim() !== "");
    } catch (error) {
      console.error("Error reading proxy database:", error);
    }

    res.json({
      success: true,
      count: proxies.length,
      proxies,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Batch processing endpoint
app.post("/api/batch-process", requireAuth, async (req, res) => {
  try {
    // Implementation for batch processing would go here
    res.json({ success: true, jobId: Date.now().toString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/download', requireAuth, (req, res) => {
  try {
    const filePath = req.query.file;

    // بررسی اعتبار مسیر فایل (برای جلوگیری از path traversal)
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(path.join(__dirname, 'output'))) {
      return res.status(403).send('دسترسی غیرمجاز');
    }

    // بررسی وجود فایل
    if (!fs.existsSync(normalizedPath)) {
      return res.status(404).send('فایل یافت نشد');
    }

    // استخراج نام فایل از مسیر
    const fileName = path.basename(normalizedPath);

    // ارسال فایل
    res.download(normalizedPath, fileName);
  } catch (error) {
    console.error('خطا در دانلود فایل:', error);
    res.status(500).send('خطا در دانلود فایل');
  }
});

// مسیر صفحه پردازش دسته‌ای
app.get('/batch', requireAuth, (req, res) => {
  res.render('batch', { title: 'Batch Processing - PlayStation API Tool' });
});

// مسیر پردازش دسته‌ای
app.post('/batch-process', requireAuth, async (req, res) => {
  try {
    // بررسی فایل آپلود شده
    if (!req.files || !req.files.accountsFile) {
      return res.render('error', {
        title: 'Error',
        message: 'No accounts file uploaded'
      });
    }

    const accountsFile = req.files.accountsFile;
    const batchSize = parseInt(req.body.batchSize) || 1;
    const useProxy = req.body.useProxy === 'true';

    // ذخیره فایل آپلود شده
    const uploadDir = path.join(__dirname, 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    const filePath = path.join(uploadDir, accountsFile.name);
    await accountsFile.mv(filePath);

    // تجزیه فایل اکانت‌ها
    const accounts = await parseAccountsFile(filePath);

    if (accounts.length === 0) {
      return res.render('error', {
        title: 'Error',
        message: 'No valid accounts found in the uploaded file'
      });
    }

    // ایجاد شناسه منحصر به فرد برای این دسته
    const batchId = Date.now().toString();

    // ذخیره اطلاعات دسته
    activeBatches.set(batchId, {
      id: batchId,
      accounts,
      batchSize,
      useProxy,
      status: 'initializing',
      startTime: new Date(),
      completedCount: 0,
      errorCount: 0,
      currentIndex: 0,
      results: {},
      failedAccounts: []
    });

    // رندر صفحه نتایج دسته‌ای
    res.render('batch-result', {
      title: 'Batch Processing Results',
      batchId
    });

    // شروع پردازش دسته‌ای پس از کمی تاخیر
    setTimeout(() => {
      processBatch(batchId);
    }, 1000);

  } catch (error) {
    console.error('Error in batch processing:', error);
    res.render('error', {
      title: 'Error',
      message: error.message
    });
  }
});

// API endpoint برای پیوستن به اتاق دسته‌ای
app.post('/api/batch/:batchId/join', requireAuth, (req, res) => {
  const { batchId } = req.params;
  const { socketId } = req.body;

  if (!socketId) {
    return res.status(400).json({ error: 'Socket ID is required' });
  }

  const batch = activeBatches.get(batchId);
  if (!batch) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  const socket = io.sockets.sockets.get(socketId);
  if (!socket) {
    return res.status(404).json({ error: 'Socket not found', socketId });
  }

  const roomName = `batch-${batchId}`;
  socket.join(roomName);

  console.log(`Socket ${socketId} joined batch room ${roomName}`);

  // ارسال اطلاعات اولیه دسته به کلاینت
  socket.emit('batch-init', {
    batchId,
    accounts: batch.accounts.map(account => ({
      credentials: account.credentials,
      npsso: account.npsso.substring(0, 5) + '...' // نمایش بخشی از NPSSO برای امنیت
    })),
    batchSize: batch.batchSize,
    useProxy: batch.useProxy
  });

  res.json({ success: true, room: roomName });
});

// API endpoint برای دریافت وضعیت دسته
app.get('/api/batch/:batchId', requireAuth, (req, res) => {
  const { batchId } = req.params;
  const batch = activeBatches.get(batchId);

  if (!batch) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  // حذف اطلاعات حساس قبل از ارسال
  const sanitizedBatch = {
    ...batch,
    accounts: batch.accounts.map(account => ({
      credentials: account.credentials.split(':')[0] + ':***',
      npsso: account.npsso.substring(0, 5) + '...'
    }))
  };

  res.json(sanitizedBatch);
});

// تابع اصلی پردازش دسته‌ای
async function processBatch(batchId) {
  const batch = activeBatches.get(batchId);
  if (!batch) {
    console.error(`Batch ${batchId} not found`);
    return;
  }

  // آپدیت وضعیت دسته
  batch.status = 'processing';

  // اتاق Socket.IO برای این دسته
  const roomName = `batch-${batchId}`;

  // اعلام شروع پردازش به کلاینت
  io.to(roomName).emit('batch-init', {
    batchId,
    accounts: batch.accounts.map(account => ({
      credentials: account.credentials,
      npsso: account.npsso.substring(0, 5) + '...' // نمایش بخشی از NPSSO برای امنیت
    })),
    batchSize: batch.batchSize,
    useProxy: batch.useProxy
  });

  // تابع برای پردازش یک اکانت
  const processAccount = async (index) => {
    if (index >= batch.accounts.length) {
      return;
    }

    const account = batch.accounts[index];
    const { credentials, npsso } = account;

    // اعلام شروع پردازش اکانت به کلاینت
    io.to(roomName).emit('account-start', { index, credentials });

    try {
      // پردازش اکانت با استفاده از تابع runPsnApiTool
      await new Promise((resolve, reject) => {
        runPsnApiTool({
          credentials,
          npsso,
          proxyData: batch.useProxy ? true : null,
          onProgress: (message) => {
            console.log(`[Batch ${batchId}][Account ${index}] Progress: ${message}`);
            io.to(roomName).emit('account-progress', { index, message });
          },
          onData: (data) => {
            // اطلاعات میانی را نگه نمی‌داریم
          },
          onComplete: (results) => {
            console.log(`[Batch ${batchId}][Account ${index}] Complete`);

            // ذخیره نتیجه
            batch.results[index] = results;
            batch.completedCount++;

            // اعلام تکمیل اکانت به کلاینت
            io.to(roomName).emit('account-complete', { index, results });

            resolve(results);
          },
          onError: (error) => {
            console.error(`[Batch ${batchId}][Account ${index}] Error:`, error);

            // افزودن به لیست اکانت‌های با خطا
            batch.failedAccounts.push({
              credentials,
              npsso,
              error: error.message
            });
            batch.errorCount++;

            // اعلام خطا به کلاینت با ارسال اطلاعات کامل اکانت
            io.to(roomName).emit('account-error', {
              index,
              error: error.message,
              credentials,
              npsso
            });

            reject(error);
          }
        });
      }).catch(error => {
        console.error(`Error processing account ${index} in batch ${batchId}:`, error);
      });
    } catch (error) {
      console.error(`Error in processAccount for index ${index}:`, error);
    }
  };

  // پردازش اکانت‌ها به صورت دسته‌ای
  try {
    // تعیین تعداد اکانت‌های پردازش شده همزمان
    const batchSize = Math.min(batch.batchSize, 5); // حداکثر 5 اکانت همزمان

    // پردازش اکانت‌ها در دسته‌های کوچک
    for (let i = 0; i < batch.accounts.length; i += batchSize) {
      const currentBatchPromises = [];

      // ایجاد پرامیس‌ها برای این دسته
      for (let j = 0; j < batchSize && i + j < batch.accounts.length; j++) {
        currentBatchPromises.push(processAccount(i + j));
      }

      // منتظر تکمیل این دسته می‌شویم
      await Promise.allSettled(currentBatchPromises);
    }

    // آپدیت وضعیت دسته
    batch.status = 'completed';
    batch.endTime = new Date();

    // اعلام تکمیل دسته به کلاینت
    io.to(roomName).emit('batch-complete', {
      completedCount: batch.completedCount,
      errorCount: batch.errorCount,
      totalTime: (batch.endTime - batch.startTime) / 1000, // به ثانیه
      failedAccounts: batch.failedAccounts // ارسال اطلاعات کامل اکانت‌های ناموفق
    });

    // ذخیره اکانت‌های با خطا در فایل
    if (batch.failedAccounts.length > 0) {
      try {
        const outputDir = path.join(__dirname, 'output');
        await fs.mkdir(outputDir, { recursive: true });

        const date = new Date().toISOString().split('T')[0];
        const failedFilePath = path.join(outputDir, `failed-accounts-${date}.txt`);

        let content = '';
        batch.failedAccounts.forEach((account, index) => {
          content += `Email:pass : ${account.credentials}\n`;
          content += `Npsso : ${account.npsso}\n`;

          if (index < batch.failedAccounts.length - 1) {
            content += '-----------------------------------------------------------------------\n';
          }
        });

        await fs.writeFile(failedFilePath, content, 'utf8');
        console.log(`Failed accounts saved to ${failedFilePath}`);
      } catch (error) {
        console.error('Error saving failed accounts:', error);
      }
    }

  } catch (error) {
    console.error(`Error processing batch ${batchId}:`, error);

    // آپدیت وضعیت دسته
    batch.status = 'error';
    batch.endTime = new Date();
    batch.error = error.message;

    // اعلام خطا به کلاینت
    io.to(roomName).emit('batch-error', { error: error.message });
  }
}

// ایجاد دایرکتوری خروجی در شروع برنامه
(async function () {
  try {
    await fs.mkdir(path.join(__dirname, 'output'), { recursive: true });
  } catch (error) {
    console.error('خطا در ایجاد دایرکتوری خروجی:', error);
  }
})();

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
