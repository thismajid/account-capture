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

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Set up EJS as the view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  fileUpload({
    createParentPath: true,
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB max file size
    },
  })
);

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

// Add proxies to database without duplicates
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

// Initialize data directory on startup
ensureDataDirectory();

// Routes
app.get("/", (req, res) => {
  res.render("index", { title: "PlayStation API Tool" });
});

app.post('/run-tool', async (req, res) => {
  try {
    const { credentials, npsso, useProxy } = req.body;
    let proxyFile = null;
    let proxyData = null;
    let selectedProxy = null;
    
    // Validate credentials format without splitting
    if (!credentials || !credentials.includes(':')) {
      throw new Error('Invalid credentials format. Please use email:password format.');
    }
    
    console.log('Received request with credentials');
    console.log('Use proxy:', useProxy === 'true' ? 'Yes' : 'No');
    
    // Check if proxy file was uploaded
    if (req.files && req.files.proxyFile) {
      const uploadedFile = req.files.proxyFile;
      const uploadDir = path.join(__dirname, 'uploads');
      
      // Ensure upload directory exists
      await fs.mkdir(uploadDir, { recursive: true });
      
      // Save the file
      const filePath = path.join(uploadDir, uploadedFile.name);
      await uploadedFile.mv(filePath);
      
      // Read proxy data
      proxyData = await fs.readFile(filePath, 'utf8');
      console.log('Proxy file loaded:', uploadedFile.name);
      
      // Add proxies to database
      const proxies = proxyData.split('\n').filter(line => line.trim() !== '');
      const dbResult = await addProxiesToDatabase(proxies);
      console.log(`Added ${dbResult.addedProxies} new proxies to database. Total proxies: ${dbResult.totalProxies}`);
      
      proxyFile = filePath;
    }
    
    // Only try to get a working proxy if useProxy is true
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
        
        // Test both protocols (HTTPS and SOCKS5)
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
    
    // Store job info
    activeJobs.set(jobId, {
      status: 'running',
      startTime: new Date(),
      credentials,
      results: null
    });
    
    // Render the result page immediately
    res.render('result', { 
      title: 'Processing Request',
      jobId,
      initialStatus: 'running'
    });
    
    // Add a short delay to ensure the result page is fully loaded
    setTimeout(() => {
      console.log('Starting PSN API tool for job:', jobId);
      
      // Run the PSN API tool in the background with the combined credentials
      runPsnApiTool({
        credentials,  // Pass the combined credentials directly
        npsso,
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
          console.log(`[${jobId}] Complete`);
          activeJobs.set(jobId, {
            ...activeJobs.get(jobId),
            status: 'completed',
            endTime: new Date(),
            results
          });
          
          io.to(roomName).emit('complete', { results });
        },
        onError: (error) => {
          console.error(`[${jobId}] Error:`, error);
          activeJobs.set(jobId, {
            ...activeJobs.get(jobId),
            status: 'error',
            endTime: new Date(),
            error: error.message
          });
          
          io.to(roomName).emit('error', { error: error.message });
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

// API endpoint to get job status
app.get("/api/job/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json(job);
});

// Join a job room for real-time updates
app.post("/api/job/:jobId/join", (req, res) => {
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
app.post("/api/test-proxy", async (req, res) => {
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
app.post("/api/upload-proxies", async (req, res) => {
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
app.get("/api/proxies", async (req, res) => {
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
app.post("/api/batch-process", async (req, res) => {
  try {
    // Implementation for batch processing would go here
    res.json({ success: true, jobId: Date.now().toString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/download', (req, res) => {
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

// ایجاد دایرکتوری خروجی در شروع برنامه
(async function() {
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
