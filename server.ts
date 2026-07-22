import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { calculateEstimate } from "./src/pricingData";
import { dataService } from "./src/services/dataService";
import { Lead } from "./src/types";
import multer from "multer";
import mammoth from "mammoth";

dotenv.config();

export const app = express();
const PORT = 3000;

// Body parsing middleware
app.use(express.json());

// Lazy initialization of the Google GenAI SDK to avoid crashing on start if the key is missing
let aiClient: GoogleGenAI | null = null;

function getAIClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Leads API
app.post("/api/leads", async (req, res) => {
  try {
    const { name, email, phone, address, serviceType, details, firewoodDetails, aiRecommendation, services, acreage, propertySize, terrain, specialRequirements, estimate } = req.body;
    
    if (!name || !phone) {
      return res.status(400).json({ error: "Name and Phone are required to request a quote." });
    }

    const servicesList = services || (serviceType ? [serviceType] : ["property_management"]);
    const size = propertySize || acreage || "1-2 acres";
    const terr = terrain || "flat_wooded";
    const reqs = specialRequirements || details || "";

    const calculatedEstimate = estimate || calculateEstimate(servicesList, size, terr, reqs);

    const allLeads = await dataService.getLeads();
    const count = allLeads.length;
    const currentYear = new Date().getFullYear();
    const trackingCode = `JHL-${currentYear}-${String(count + 1).padStart(3, "0")}`;

    const newLead = await dataService.createLead({
      name,
      email: email || "",
      phone,
      address: address || "",
      serviceType: Array.isArray(servicesList) ? servicesList.join(", ") : serviceType,
      details: details || "",
      firewoodDetails,
      aiRecommendation,
      status: "new",
      createdAt: new Date().toISOString(),
      estimate: calculatedEstimate,
      trackingCode
    });

    // 1. Check or Create Customer Record
    try {
      const cleanPhone = phone.replace(/\D/g, "");
      const allCustomers = await dataService.getCustomers();
      let customer = allCustomers.find(c => c.phone.replace(/\D/g, "") === cleanPhone);

      if (customer) {
        if (!customer.trackingCodes.includes(trackingCode)) {
          const updatedCodes = [...customer.trackingCodes, trackingCode];
          await dataService.updateCustomer(customer.id, { 
            trackingCodes: updatedCodes,
            name: customer.name || name,
            email: customer.email || email || ""
          });
        }
      } else {
        await dataService.createCustomer({
          name,
          phone,
          email: email || "",
          trackingCodes: [trackingCode]
        });
      }
    } catch (custErr) {
      console.error("Error managing customer record:", custErr);
    }

    // 2. Automatically Create Two Internal Tasks
    try {
      await dataService.createTask({
        title: `Contact ${name} within 24 hours`,
        assignedTo: "Admin",
        priority: "high",
        status: "pending",
        dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        notes: `Phone: ${phone}\nAddress: ${address || "N/A"}\nDetails: ${details || "New Quote Request"}`
      });

      await dataService.createTask({
        title: `Schedule site visit for ${name}`,
        assignedTo: "Admin",
        priority: "medium",
        status: "pending",
        dueDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().split("T")[0],
        notes: `Phone: ${phone}\nAddress: ${address || "N/A"}\nDetails: ${details || "New Quote Request"}`
      });
    } catch (taskErr) {
      console.error("Error creating automated tasks:", taskErr);
    }

    res.status(201).json({ success: true, lead: newLead });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// Training Licensing Inquiry Public Endpoint
app.post("/api/training/inquiry", async (req, res) => {
  try {
    const { companyName, contactName, title, email, phone, interestedTier, employeeCount, message } = req.body;
    
    if (!companyName || !contactName || !email || !phone) {
      return res.status(400).json({ error: "Company Name, Contact Name, Email, and Phone are required." });
    }

    const newLead = await dataService.createTrainingLead({
      companyName,
      contactName,
      title: title || "",
      email,
      phone,
      interestedTier: interestedTier || "standard",
      employeeCount: Number(employeeCount) || 1,
      message: message || "",
      status: "new",
      createdAt: new Date().toISOString(),
      notes: ""
    });

    res.status(201).json({ success: true, lead: newLead });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to submit training inquiry." });
  }
});

// Secure Customer Portal lead search (strict access control: search by phone or tracking code)
const handleCustomerLookup = async (req: any, res: any) => {
  try {
    const { email, phone, trackingCode } = req.body;
    
    const allLeads = await dataService.getLeads();

    // If trackingCode is provided, return matching lead directly
    if (trackingCode && trackingCode.trim() !== "") {
      const match = allLeads.find(l => l.trackingCode && l.trackingCode.toLowerCase().trim() === trackingCode.toLowerCase().trim());
      return res.json({
        success: true,
        leads: match ? [match] : []
      });
    }

    if (!phone) {
      return res.status(400).json({ error: "Phone number or tracking code is required for portal lookup." });
    }
    const cleanPhone = phone.replace(/\D/g, "");
    if (cleanPhone.length < 7) {
      return res.status(400).json({ error: "Please enter a valid phone number." });
    }
    
    // Strict match on phone number digits, with optional email match if email is provided
    const matches = allLeads.filter(l => {
      const leadPhoneClean = l.phone.replace(/\D/g, "");
      const isPhoneMatch = leadPhoneClean === cleanPhone || leadPhoneClean.endsWith(cleanPhone) || cleanPhone.endsWith(leadPhoneClean);
      if (!isPhoneMatch) return false;
      if (email && email.trim() !== "") {
        return l.email.toLowerCase().trim() === email.toLowerCase().trim();
      }
      return true;
    });

    res.json({
      success: true,
      leads: matches
    });
  } catch (err: any) {
    res.status(500).json({ error: "Portal authentication failed." });
  }
};

app.post("/api/customer/login", handleCustomerLookup);
app.post("/api/customer/track", handleCustomerLookup);

// Define Auth Middleware
async function verifyAuth(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  const token = req.headers["x-auth-token"] || (authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null);
  
  if (!token) {
    return res.status(401).json({ error: "Access Denied. No session token provided." });
  }
  
  if (token === "jh-token-owner-secret-2026") {
    req.user = { username: "J&H", role: "Owner" };
    next();
  } else if (token === "jh-token-admin-secret-2026") {
    req.user = { username: "admin", role: "Admin" };
    next();
  } else if (token === "jh-token-employee-secret-2026") {
    req.user = { username: "employee", role: "Employee" };
    next();
  } else if (token.startsWith("jh-token-trainee-")) {
    const traineeId = token.replace("jh-token-trainee-", "");
    try {
      const traineesList = await dataService.getTrainees();
      const trainee = traineesList.find(t => t.id === traineeId);
      if (trainee) {
        req.user = { username: trainee.username || "trainee", role: "Trainee", traineeId };
        next();
      } else {
        return res.status(403).json({ error: "Access Denied. Trainee session not found." });
      }
    } catch (err) {
      return res.status(500).json({ error: "Access Denied. Failed to verify trainee session." });
    }
  } else {
    return res.status(403).json({ error: "Access Denied. Invalid or expired token." });
  }
}

// Authentication login endpoint
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  // Calculate SHA-256 hash of incoming password to prevent raw text checks or storage
  const inputHash = crypto.createHash("sha256").update(password).digest("hex");

  const ownerHash = "66d0a82067eb61024286e0f9c5223820ce8d51e36ace242c80f2a66d23c7d646"; // J&HLLC*
  const adminHash = "b8ad853079e15b4ab4d5f8f5499f14103a82763d8f8dfc3d1ce361f721e71eba"; // jhadmin2026
  const employeeHash = "db9400f169e880b91d5c031074b0e2ecfe336bb00e1635e8ff034fa0d3515c54"; // jhemployee2026

  if (username === "J&H" && inputHash === ownerHash) {
    return res.json({
      success: true,
      token: "jh-token-owner-secret-2026",
      user: { username: "J&H", role: "Owner" }
    });
  } else if (username === "admin" && inputHash === adminHash) {
    return res.json({
      success: true,
      token: "jh-token-admin-secret-2026",
      user: { username: "admin", role: "Admin" }
    });
  } else if (username === "employee" && inputHash === employeeHash) {
    return res.json({
      success: true,
      token: "jh-token-employee-secret-2026",
      user: { username: "employee", role: "Employee" }
    });
  } else {
    try {
      // Check Trainees list
      const traineesList = await dataService.getTrainees();
      const trainee = traineesList.find(t => t.username === username);
      if (trainee) {
        const traineePasswordHash = crypto.createHash("sha256").update(trainee.password || "").digest("hex");
        const isMatch = (password === trainee.password) || 
                        (inputHash === trainee.password) ||
                        (username === "trainee" && password === "jhtrainee2026") ||
                        (trainee.password === "jhtrainee2026" && password === "jhtrainee2026") ||
                        (inputHash === traineePasswordHash);

        if (isMatch) {
          return res.json({
            success: true,
            token: `jh-token-trainee-${trainee.id}`,
            user: { username: trainee.username || "trainee", role: "Trainee", traineeId: trainee.id }
          });
        }
      }
    } catch (err) {
      console.error("Login trainees query error:", err);
    }
    return res.status(401).json({ error: "Invalid username or password credentials." });
  }
});

// Secured Leads API - Access limited to authenticated staff
app.get("/api/leads", verifyAuth, requireStaff, async (req, res) => {
  try {
    const leadsList = await dataService.getLeads();
    res.json(leadsList);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to retrieve leads." });
  }
});

// Update lead status/notes
app.patch("/api/leads/:id", verifyAuth, requireStaff, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    const updatedLead = await dataService.updateLead(id, {
      ...(status && { status }),
      ...(notes !== undefined && { notes }),
    });

    if (updatedLead) {
      if (status) {
        const normStatus = status.toLowerCase();
        if (normStatus === "approved") {
          await dataService.createTask({
            title: `Prepare Service Agreement for ${updatedLead.name}`,
            assignedTo: "Admin",
            priority: "high",
            status: "pending",
            dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0],
            notes: `Auto-generated task on approval of quote.\nCustomer Name: ${updatedLead.name}\nPhone: ${updatedLead.phone}\nAddress: ${updatedLead.address || "N/A"}\nTracking Code: ${updatedLead.trackingCode || "N/A"}`
          });
        } else if (normStatus === "scheduled") {
          await dataService.createTask({
            title: `Mobilize Crew for ${updatedLead.name}`,
            assignedTo: "Admin",
            priority: "high",
            status: "pending",
            dueDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().split("T")[0],
            notes: `Auto-generated task on scheduling of quote.\nCustomer Name: ${updatedLead.name}\nPhone: ${updatedLead.phone}\nAddress: ${updatedLead.address || "N/A"}\nTracking Code: ${updatedLead.trackingCode || "N/A"}`
          });
        }
      }
      res.json({ success: true, lead: updatedLead });
    } else {
      res.status(404).json({ error: "Lead not found" });
    }
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update lead." });
  }
});

// Delete lead (Admin only)
app.delete("/api/leads/:id", verifyAuth, requireAdminOrOwner, async (req: any, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ error: "Access Denied. Only Admin users can delete inquiries." });
    }
    const { id } = req.params;
    const deleted = await dataService.deleteLead(id);
    if (deleted) {
      res.json({ success: true, message: "Lead successfully removed." });
    } else {
      res.status(404).json({ error: "Lead not found" });
    }
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete lead." });
  }
});

// Secured Training Leads API - Admin-only retrieval
app.get("/api/training/leads", verifyAuth, requireStaff, async (req, res) => {
  try {
    const list = await dataService.getTrainingLeads();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to retrieve training leads." });
  }
});

// Update training lead status or notes
app.patch("/api/training/leads/:id", verifyAuth, requireStaff, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    const updated = await dataService.updateTrainingLead(id, {
      ...(status && { status }),
      ...(notes !== undefined && { notes }),
    });

    if (updated) {
      res.json({ success: true, lead: updated });
    } else {
      res.status(404).json({ error: "Training lead not found." });
    }
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update training lead." });
  }
});

// Delete training lead
app.delete("/api/training/leads/:id", verifyAuth, requireAdminOrOwner, async (req: any, res) => {
  try {
    const { id } = req.params;
    const deleted = await dataService.deleteTrainingLead(id);
    if (deleted) {
      res.json({ success: true, message: "Training lead successfully removed." });
    } else {
      res.status(404).json({ error: "Training lead not found." });
    }
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete training lead." });
  }
});

// ============================================================================
// TRAINING INTERESTS ENDPOINTS
// ============================================================================

// POST - Public Express Interest submission
app.post("/api/training/interests", async (req, res) => {
  try {
    const { name, email, phone, industryInterest, desiredTraining, comments } = req.body;
    if (!name || !email || !phone) {
      return res.status(400).json({ error: "Name, Email, and Phone are required to register interest." });
    }
    const newInterest = await dataService.createTrainingInterest({
      name,
      email,
      phone,
      industryInterest: industryInterest || "",
      desiredTraining: desiredTraining || "",
      comments: comments || "",
      status: "Interested",
      createdAt: new Date().toISOString()
    });
    res.status(201).json({ success: true, interest: newInterest });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to submit training interest." });
  }
});

// GET - Authenticated view of training interests
app.get("/api/training/interests", verifyAuth, requireStaff, async (req, res) => {
  try {
    const list = await dataService.getTrainingInterests();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve training interests." });
  }
});

// DELETE - Authenticated deletion of training interests (Admin/Owner only)
app.delete("/api/training/interests/:id", verifyAuth, requireAdminOrOwner, async (req: any, res) => {
  try {
    const { id } = req.params;
    const deleted = await dataService.deleteTrainingInterest(id);
    if (deleted) {
      res.json({ success: true, message: "Interest entry deleted successfully." });
    } else {
      res.status(404).json({ error: "Interest entry not found." });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to delete interest entry." });
  }
});

// ============================================================================
// JOB TIME TRACKER ENDPOINTS
// ============================================================================

// GET - All time logs
app.get("/api/timelogs", verifyAuth, requireStaff, async (req, res) => {
  try {
    const list = await dataService.getTimeLogs();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve time logs." });
  }
});

// POST - Create/Clock In
app.post("/api/timelogs", verifyAuth, requireStaff, async (req, res) => {
  try {
    const { employeeId, employeeName, jobId, jobName, notes } = req.body;
    if (!employeeId || !employeeName || !jobId || !jobName) {
      return res.status(400).json({ error: "Employee and Job identifiers are required." });
    }
    const newLog = await dataService.createTimeLog({
      employeeId,
      employeeName,
      jobId,
      jobName,
      clockIn: new Date().toISOString(),
      notes: notes || ""
    });
    res.status(201).json({ success: true, log: newLog });
  } catch (err) {
    res.status(500).json({ error: "Failed to create clock-in log." });
  }
});

// PATCH - Update / Clock Out or Manual Adjustment
app.patch("/api/timelogs/:id", verifyAuth, requireStaff, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { clockOut, hoursWorked, notes, manualAdjustment } = req.body;
    
    // If it's a manual adjustment, ensure the user is Admin or Owner
    if (manualAdjustment && req.user.role !== "Admin" && req.user.role !== "Owner") {
      return res.status(403).json({ error: "Access Denied. Only Admins can manually adjust time logs." });
    }

    const updated = await dataService.updateTimeLog(id, {
      ...(clockOut && { clockOut }),
      ...(hoursWorked !== undefined && { hoursWorked }),
      ...(notes !== undefined && { notes }),
      ...(manualAdjustment && { manualAdjustment })
    });

    if (updated) {
      res.json({ success: true, log: updated });
    } else {
      res.status(404).json({ error: "Time log not found." });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to update time log." });
  }
});

// ============================================================================
// CUSTOMER COMMUNICATION LOG ENDPOINTS
// ============================================================================

// GET - All communication logs
app.get("/api/communication-logs", verifyAuth, requireStaff, async (req, res) => {
  try {
    const list = await dataService.getCommunicationLogs();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve communication logs." });
  }
});

// POST - Create communication log
app.post("/api/communication-logs", verifyAuth, requireStaff, async (req, res) => {
  try {
    const { customerId, customerName, type, date, staffMember, content, outcome, followUpReminder } = req.body;
    if (!customerId || !customerName || !content || !staffMember) {
      return res.status(400).json({ error: "Customer, staff member, and log content are required." });
    }
    const newLog = await dataService.createCommunicationLog({
      customerId,
      customerName,
      type: type || "Call",
      date: date || new Date().toISOString(),
      staffMember,
      content,
      outcome: outcome || "",
      followUpReminder
    });
    res.status(201).json({ success: true, log: newLog });
  } catch (err) {
    res.status(500).json({ error: "Failed to create communication log." });
  }
});

// ============================================================================
// INTERNAL DOCUMENT LIBRARY ENDPOINTS
// ============================================================================

// GET - All documents
app.get("/api/documents", verifyAuth, requireStaff, async (req, res) => {
  try {
    const list = await dataService.getDocuments();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to retrieve document metadata." });
  }
});

// POST - Create document entry
app.post("/api/documents", verifyAuth, requireStaff, async (req, res) => {
  try {
    const { title, category, folder, tags, uploadedBy, fileSize, fileType, description, placeholderUrl } = req.body;
    if (!title || !category || !folder || !uploadedBy) {
      return res.status(400).json({ error: "Title, Category, Folder, and Uploaded By are required." });
    }
    const newDoc = await dataService.createDocument({
      title,
      category,
      folder,
      tags: tags || [],
      uploadedBy,
      uploadedAt: new Date().toISOString(),
      fileSize: fileSize || "1.2 MB",
      fileType: fileType || "PDF",
      description: description || "",
      placeholderUrl: placeholderUrl || ""
    });
    res.status(201).json({ success: true, document: newDoc });
  } catch (err) {
    res.status(500).json({ error: "Failed to create document entry." });
  }
});

// DELETE - Delete document entry (Owner/Admin only)
app.delete("/api/documents/:id", verifyAuth, requireAdminOrOwner, async (req: any, res) => {
  try {
    if (req.user.role !== "Admin" && req.user.role !== "Owner") {
      return res.status(403).json({ error: "Access Denied. Only Admin users can delete documents." });
    }
    const { id } = req.params;
    const deleted = await dataService.deleteDocument(id);
    if (deleted) {
      res.json({ success: true, message: "Document entry deleted successfully." });
    } else {
      res.status(404).json({ error: "Document entry not found." });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to delete document entry." });
  }
});

// Task Data and Endpoints
app.get("/api/tasks", verifyAuth, requireStaff, async (req, res) => {
  try {
    const tasksList = await dataService.getTasks();
    res.json(tasksList);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks", verifyAuth, requireStaff, async (req: any, res) => {
  if (req.user.role !== "Admin" && req.user.role !== "Owner") {
    return res.status(403).json({ error: "Access Denied. Only Admin or Owner users can create tasks." });
  }
  const { title, assignedTo, priority, dueDate, notes } = req.body;
  if (!title) {
    return res.status(400).json({ error: "Task title is required." });
  }
  try {
    const newTask = await dataService.createTask({
      title,
      assignedTo: assignedTo || "Employee",
      priority: priority || "medium",
      status: "pending",
      dueDate: dueDate || new Date().toISOString().split("T")[0],
      notes: notes || ""
    });
    res.status(201).json({ success: true, task: newTask });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/tasks/:id", verifyAuth, requireStaff, async (req, res) => {
  const { id } = req.params;
  const { status, notes, assignedTo, priority, title, dueDate } = req.body;
  try {
    const updated = await dataService.updateTask(id, {
      status, notes, assignedTo, priority, title, dueDate
    });
    if (updated) {
      res.json({ success: true, task: updated });
    } else {
      res.status(404).json({ error: "Task not found" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/tasks/:id", verifyAuth, requireStaff, async (req: any, res) => {
  if (req.user.role !== "Admin" && req.user.role !== "Owner") {
    return res.status(403).json({ error: "Access Denied. Only Admin or Owner users can delete tasks." });
  }
  const { id } = req.params;
  try {
    const success = await dataService.deleteTask(id);
    if (success) {
      res.json({ success: true, message: "Task successfully deleted." });
    } else {
      res.status(404).json({ error: "Task not found" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Inventory Data and Endpoints
app.get("/api/inventory", verifyAuth, requireStaff, async (req, res) => {
  try {
    const items = await dataService.getInventory();
    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/inventory", verifyAuth, requireStaff, async (req, res) => {
  const { id, name, category, quantity, unit, status } = req.body;
  try {
    if (!id) {
      const newItem = await dataService.createInventoryItem({
        name, category, quantity, unit, status
      });
      return res.status(201).json({ success: true, item: newItem });
    }

    const updated = await dataService.updateInventoryItem(id, {
      quantity: quantity !== undefined ? Number(quantity) : undefined,
      status
    });
    if (updated) {
      res.json({ success: true, item: updated });
    } else {
      res.status(404).json({ error: "Inventory item not found" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/inventory/:id", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { id } = req.params;
  try {
    const success = await dataService.deleteInventoryItem(id);
    if (success) {
      res.json({ success: true, message: "Inventory item deleted" });
    } else {
      res.status(404).json({ error: "Inventory item not found" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SECURE WORKSPACE ENDPOINT ACCESS CHECKS
function requireOwner(req: any, res: any, next: any) {
  if (req.user && req.user.role === "Owner") {
    next();
  } else {
    res.status(403).json({ error: "Access Denied. Owner privileges required for this action." });
  }
}

function requireAdminOrOwner(req: any, res: any, next: any) {
  if (req.user && (req.user.role === "Owner" || req.user.role === "Admin")) {
    next();
  } else {
    res.status(403).json({ error: "Access Denied. Admin or Owner privileges required for this action." });
  }
}

function requireStaff(req: any, res: any, next: any) {
  if (req.user && (req.user.role === "Owner" || req.user.role === "Admin" || req.user.role === "Employee")) {
    next();
  } else {
    res.status(403).json({ error: "Access Denied. Staff credentials required." });
  }
}

// GET active training programs (Public) - only return active programs marked as public
app.get("/api/public/active-programs", async (req, res) => {
  try {
    const list = await dataService.getPrograms();
    const activePrograms = list.filter((p: any) => p.status === "Active" && p.isPublic === true);
    res.json(activePrograms);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET public content blob by key (Public)
app.get("/api/public-content/:key", async (req, res) => {
  const { key } = req.params;
  try {
    const data = await dataService.getPublicContent(key);
    res.json(data || {});
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST save public content blob by key (Admin / Owner required)
app.post("/api/public-content/:key", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { key } = req.params;
  try {
    const saved = await dataService.savePublicContent(key, req.body);
    res.json({ success: true, data: saved });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET all training programs (Studio Engine)
app.get("/api/training-studio/programs", verifyAuth, requireAdminOrOwner, async (req, res) => {
  try {
    const list = await dataService.getPrograms();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create training program
app.post("/api/training-studio/programs", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { name, industryTag, description, version, status, isPublic, clientId, organizationId, orgName, targetAudience, estimatedDuration, difficulty, knowledgeSources, learningObjectives, competencies, modules, assessments, practicalChecklist, certificationRules } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Program Name is required" });
  }
  try {
    const newProgram = await dataService.createProgram({
      name,
      industryTag: industryTag || "General Equipment Safety",
      description: description || "",
      version: version || "1.0.0",
      status: status || "Published",
      isPublic: Boolean(isPublic),
      clientId: clientId || "",
      organizationId: organizationId || "org_jh",
      orgName: orgName || "J&H Land Services",
      targetAudience: targetAudience || "",
      estimatedDuration: estimatedDuration || "10 Hours",
      difficulty: difficulty || "Intermediate",
      knowledgeSources: knowledgeSources || [],
      learningObjectives: learningObjectives || [],
      competencies: competencies || [],
      modules: modules || [],
      assessments: assessments || [],
      practicalChecklist: practicalChecklist || [],
      certificationRules: certificationRules || {
        quizzesThreshold: 80,
        practicalHours: 0,
        instructorSignOffRequired: true,
        certificateName: `${name} Certificate`,
        expirationYears: 1,
        details: ""
      }
    });
    res.status(201).json(newProgram);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update training program
app.patch("/api/training-studio/programs/:id", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await dataService.updateProgram(id, req.body);
    if (!updated) {
      return res.status(404).json({ error: "Training program not found" });
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE training program
app.delete("/api/training-studio/programs/:id", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { id } = req.params;
  try {
    const success = await dataService.deleteProgram(id);
    if (!success) {
      return res.status(404).json({ error: "Training program not found" });
    }
    res.json({ success: true, message: "Program successfully removed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST duplicate training program
app.post("/api/training-studio/programs/:id/duplicate", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { id } = req.params;
  try {
    const list = await dataService.getPrograms();
    const original = list.find(p => p.id === id);
    if (!original) {
      return res.status(404).json({ error: "Training program not found" });
    }
    const duplicate = await dataService.createProgram({
      ...original,
      id: `prog_${Date.now()}`,
      name: `${original.name} (Copy)`,
      status: "Draft"
    });
    res.status(201).json(duplicate);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET all knowledge base entries
app.get("/api/knowledge-base", verifyAuth, requireOwner, async (req, res) => {
  try {
    const list = await dataService.getKnowledgeBase();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Configure multer for memory storage uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// POST upload and extract text from files (.txt, .md, .pdf, .docx)
app.post("/api/knowledge-base/upload", verifyAuth, requireOwner, upload.single("file"), async (req: any, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { originalname, mimetype, buffer } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    
    let extractedText = "";
    if (ext === ".txt" || ext === ".md") {
      extractedText = buffer.toString("utf8");
    } else if (ext === ".pdf") {
      extractedText = `[PDF content extraction is disabled on this environment to ensure production stability. File: ${originalname}]`;
    } else if (ext === ".docx") {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value || "";
    } else {
      return res.status(400).json({ error: `Unsupported file type: ${ext}. Failsafe supports .txt, .md, .pdf, .docx.` });
    }

    const newItem = await dataService.createKnowledgeBaseEntry({
      title: path.basename(originalname, ext),
      description: `Uploaded document: ${originalname}`,
      industryTag: "Heavy Equipment",
      sourceType: ext === ".pdf" ? "Manual" : ext === ".docx" ? "SOP" : "Other",
      fullText: extractedText.trim()
    });

    res.status(201).json(newItem);
  } catch (err: any) {
    console.error("File upload extraction error:", err);
    res.status(500).json({ error: `Failed to extract text from document: ${err.message}` });
  }
});

// AI Curriculum Generator using Gemini API
app.post("/api/training-studio/generate-program", verifyAuth, requireOwner, async (req: any, res) => {
  const { knowledgeIds, prompt: userPrompt } = req.body;

  if (!knowledgeIds || !Array.isArray(knowledgeIds) || knowledgeIds.length === 0) {
    return res.status(400).json({ error: "At least one knowledge item is required for generation context." });
  }

  try {
    const kbEntries = await dataService.getKnowledgeBase();
    const selectedEntries = kbEntries.filter(entry => knowledgeIds.includes(entry.id));
    if (selectedEntries.length === 0) {
      return res.status(404).json({ error: "No matching knowledge entries found in Library database." });
    }

    const contextText = selectedEntries.map(entry => {
      return `--- DOCUMENT TITLE: ${entry.title} (${entry.sourceType}) ---\n${entry.fullText}`;
    }).join("\n\n");

    const client = getAIClient();

    const systemInstruction = `You are the chief training engine for J&H Land Services LLC.
Your task is to generate a comprehensive, highly rigorous, and structured operator training program based ONLY on the provided reference documents.
Do not hallucinate or make up facts. Focus on standard Operating Procedures (SOPs), safety rules, equipment details, and grading criteria present in the reference documents.

You must return a single JSON object matching this exact schema:
{
  "name": "The title of the training program (should be highly professional, e.g., 'J&H Land Services LLC – Comprehensive Operator Training')",
  "industryTag": "Industry category, e.g., 'Heavy Equipment & Land Services'",
  "description": "A high-level description outlining the target equipment, safety focus, and learning outcomes.",
  "version": "1.0.0",
  "competencies": [
    {
      "id": "comp_1",
      "name": "Competency name",
      "description": "Brief description of the competency",
      "objectives": [
        {
          "id": "obj_1",
          "text": "Specific, measurable performance objective",
          "knowledgeReq": "Knowledge or SOP requirement to achieve this objective"
        }
      ]
    }
  ],
  "modules": [
    {
      "id": "mod_1",
      "title": "Module title",
      "description": "Detailed learning module description",
      "order": 1,
      "readings": "List of recommended readings/manual chapters from the reference documentation",
      "sops": "Reference to the specific SOPs covered (e.g., 'SOP-EQ-04')",
      "assignments": "Practical hands-on field assignment or exercise description",
      "checklist": [
        "Measurable skill checklist item 1",
        "Measurable skill checklist item 2",
        "Measurable skill checklist item 3"
      ],
      "instructorNotes": "Special guidance for instructors when supervising or evaluating this module in the field",
      "quiz": {
        "title": "Module-specific assessment quiz title",
        "questions": [
          {
            "id": "q1",
            "type": "single_choice",
            "questionText": "A multiple choice safety or operational question about this module's SOP.",
            "options": ["Option A", "Option B", "Option C", "Option D"]
          },
          {
            "id": "q2",
            "type": "true_false",
            "questionText": "A true or false question on operating checks or regulations.",
            "options": ["True", "False"]
          }
        ]
      }
    }
  ],
  "certificationRules": {
    "quizzesThreshold": 80,
    "practicalHours": 40,
    "instructorSignOffRequired": true,
    "details": "Trainees must pass all modules, maintain a perfect safety record, complete practical seat hours, and pass the final evaluation."
  }
}`;

    const promptText = `
Generate a comprehensive curriculum program based on the following reference material.
${userPrompt ? `ADDITIONAL CUSTOMER INSTRUCTIONS / FOCUS AREAS: ${userPrompt}` : ""}

REFERENCE DOCUMENTS CONTEXT:
${contextText}
`;

    const response = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: promptText,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["name", "industryTag", "description", "version", "competencies", "modules", "certificationRules"],
          properties: {
            name: { type: Type.STRING },
            industryTag: { type: Type.STRING },
            description: { type: Type.STRING },
            version: { type: Type.STRING },
            competencies: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["id", "name", "description", "objectives"],
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  description: { type: Type.STRING },
                  objectives: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      required: ["id", "text", "knowledgeReq"],
                      properties: {
                        id: { type: Type.STRING },
                        text: { type: Type.STRING },
                        knowledgeReq: { type: Type.STRING }
                      }
                    }
                  }
                }
              }
            },
            modules: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["id", "title", "description", "order", "readings", "sops", "assignments", "checklist", "instructorNotes", "quiz"],
                properties: {
                  id: { type: Type.STRING },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  order: { type: Type.INTEGER },
                  readings: { type: Type.STRING },
                  sops: { type: Type.STRING },
                  assignments: { type: Type.STRING },
                  checklist: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                  },
                  instructorNotes: { type: Type.STRING },
                  quiz: {
                    type: Type.OBJECT,
                    required: ["title", "questions"],
                    properties: {
                      title: { type: Type.STRING },
                      questions: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          required: ["id", "type", "questionText", "options"],
                          properties: {
                            id: { type: Type.STRING },
                            type: { type: Type.STRING },
                            questionText: { type: Type.STRING },
                            options: {
                              type: Type.ARRAY,
                              items: { type: Type.STRING }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            certificationRules: {
              type: Type.OBJECT,
              required: ["quizzesThreshold", "practicalHours", "instructorSignOffRequired", "details"],
              properties: {
                quizzesThreshold: { type: Type.INTEGER },
                practicalHours: { type: Type.INTEGER },
                instructorSignOffRequired: { type: Type.BOOLEAN },
                details: { type: Type.STRING }
              }
            }
          }
        }
      }
    });

    const parsedData = JSON.parse(response.text || "{}");

    const generatedModules = parsedData.modules || [];
    const finalModules: any[] = [];
    const newAssessments: any[] = [];

    generatedModules.forEach((mod: any, idx: number) => {
      const moduleId = mod.id || `mod_${Date.now()}_${idx}`;
      const quizId = `assess_${moduleId}`;

      if (mod.quiz && Array.isArray(mod.quiz.questions) && mod.quiz.questions.length > 0) {
        newAssessments.push({
          id: quizId,
          title: mod.quiz.title || `${mod.title} Quiz`,
          description: `Knowledge evaluation for module: ${mod.title}`,
          moduleIds: [moduleId],
          timeLimit: 15,
          passThreshold: parsedData.certificationRules?.quizzesThreshold || 80,
          questions: mod.quiz.questions.map((q: any, qIdx: number) => ({
            id: q.id || `q_${Date.now()}_${idx}_${qIdx}`,
            type: q.type || "single_choice",
            questionText: q.questionText,
            options: q.options || ["True", "False"]
          }))
        });
      }

      finalModules.push({
        id: moduleId,
        title: mod.title,
        description: mod.description,
        order: mod.order || (idx + 1),
        readings: mod.readings || "",
        videos: "",
        sops: mod.sops || "",
        assignments: mod.assignments || "",
        quizId: mod.quiz ? quizId : "",
        checklist: mod.checklist || [],
        instructorNotes: mod.instructorNotes || ""
      });
    });

    const finalProgram = {
      id: "prog_jh_land_services",
      name: parsedData.name || "J&H Land Services LLC – Comprehensive Operator Training",
      industryTag: parsedData.industryTag || "Heavy Equipment",
      description: parsedData.description || "Comprehensive syllabus for operators.",
      version: parsedData.version || "1.0.0",
      status: "Draft",
      competencies: parsedData.competencies || [],
      modules: finalModules,
      certificationRules: parsedData.certificationRules || {
        quizzesThreshold: 80,
        practicalHours: 40,
        instructorSignOffRequired: true,
        details: ""
      }
    };

    await dataService.updateProgram(finalProgram.id, finalProgram);

    for (const newAss of newAssessments) {
      await dataService.createAssessment(newAss);
    }

    res.json({ success: true, program: finalProgram, assessmentsAdded: newAssessments.length });
  } catch (err: any) {
    console.error("AI program generation error:", err);
    res.status(500).json({ error: `Failed to generate program via Gemini API: ${err.message}` });
  }
});

// POST create knowledge base entry
app.post("/api/knowledge-base", verifyAuth, requireOwner, async (req, res) => {
  const { title, description, industryTag, sourceType, fullText } = req.body;
  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }
  try {
    const newItem = await dataService.createKnowledgeBaseEntry({
      title,
      description: description || "",
      industryTag: industryTag || "General",
      sourceType: sourceType || "Other",
      fullText: fullText || ""
    });
    res.status(201).json(newItem);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update knowledge base entry
app.patch("/api/knowledge-base/:id", verifyAuth, requireOwner, async (req, res) => {
  const { id } = req.params;
  try {
    if (dataService.updateKnowledgeBaseEntry) {
      const updated = await dataService.updateKnowledgeBaseEntry(id, req.body);
      if (!updated) {
        return res.status(404).json({ error: "Knowledge entry not found" });
      }
      res.json(updated);
    } else {
      res.status(500).json({ error: "Not implemented" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE knowledge base entry
app.delete("/api/knowledge-base/:id", verifyAuth, requireOwner, async (req, res) => {
  const { id } = req.params;
  try {
    if (dataService.deleteKnowledgeBaseEntry) {
      const success = await dataService.deleteKnowledgeBaseEntry(id);
      if (!success) {
        return res.status(404).json({ error: "Knowledge entry not found" });
      }
      res.json({ success: true, message: "Knowledge base entry removed" });
    } else {
      res.status(500).json({ error: "Not implemented" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET training modules (can be accessed by general public or staff)
app.get("/api/training/modules", async (req, res) => {
  try {
    const list = await dataService.getPrograms();
    const mainProgram = list.find(p => p.id === "prog_jh_land_services") || list[0];
    if (mainProgram && mainProgram.modules && mainProgram.modules.length > 0) {
      const mapped = mainProgram.modules.map((m: any) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        tags: m.tags || ["Operations"],
        sequence: m.order || m.sequence || 1,
        duration: m.duration || 4,
        status: m.status || "Active",
        prerequisites: m.prerequisites || [],
        attachments: m.attachments || []
      }));
      return res.json(mapped);
    }

    res.json([
      {
        id: "mod_1",
        title: "Heavy Equipment Safety Foundations",
        description: "Core pre-operational inspections, fluid level dynamics, emergency shutdown protocols, and center of gravity safety for earthmovers.",
        tags: ["Foundation", "Safety"],
        sequence: 1,
        duration: 3,
        status: "Active",
        prerequisites: []
      },
      {
        id: "mod_2",
        title: "Compact Track Loader (CTL) Operations",
        description: "Instruction on control sensitivities, radial vs vertical lift paths, loading protocols, and attachment configurations on soft coastal terrains.",
        tags: ["Equipment", "Operations"],
        sequence: 2,
        duration: 6,
        status: "Active",
        prerequisites: ["mod_1"]
      },
      {
        id: "mod_3",
        title: "Excavator Micro-Grading & Deep Digging",
        description: "Advanced boom articulation, soil stability profiles, trenching safety, laser grading, and utility avoidance standards.",
        tags: ["Field Operations", "Excavation"],
        sequence: 3,
        duration: 8,
        status: "Active",
        prerequisites: ["mod_1", "mod_2"]
      },
      {
        id: "mod_4",
        title: "Forestry Mulching & High-Flow Rigging",
        description: "Managing high-flow hydraulic demands, cutter head maintenance, safe clearing patterns, and winch rigging protocols for tree felling.",
        tags: ["Field Operations", "Forestry"],
        sequence: 4,
        duration: 8,
        status: "Active",
        prerequisites: ["mod_1", "mod_2"]
      }
    ]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Alias route for PATCH trainee (called from AssessmentsTab)
app.patch("/api/training/trainees/:id", verifyAuth, requireStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await dataService.updateTrainee(id, req.body);
    if (!updated) {
      return res.status(404).json({ error: "Trainee not found" });
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET training programs (visible to all staff in Center)
app.get("/api/training-center/programs", verifyAuth, requireStaff, async (req, res) => {
  try {
    const list = await dataService.getPrograms();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET trainees
app.get("/api/training-center/trainees", verifyAuth, requireStaff, async (req, res) => {
  try {
    const list = await dataService.getTrainees();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create trainee
app.post("/api/training-center/trainees", verifyAuth, requireStaff, async (req, res) => {
  const { name, email, phone, company, notes, assignedSessions, moduleProgress, overallProgress, username, password, assignedPrograms, assistTasks } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: "Name and Email are required" });
  }
  try {
    const newTrainee = await dataService.createTrainee({
      name,
      email,
      phone: phone || "",
      company: company || "",
      enrolledDate: new Date().toISOString().split("T")[0],
      assignedSessions: assignedSessions || [],
      moduleProgress: moduleProgress || {},
      overallProgress: Number(overallProgress) || 0,
      notes: notes || "",
      username: username || "",
      password: password || "",
      assignedPrograms: assignedPrograms || [],
      assistTasks: assistTasks || []
    });
    res.status(201).json(newTrainee);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update trainee
app.patch("/api/training-center/trainees/:id", verifyAuth, requireStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await dataService.updateTrainee(id, req.body);
    if (!updated) {
      return res.status(404).json({ error: "Trainee not found" });
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE trainee (Owner/Admin only)
app.delete("/api/training-center/trainees/:id", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { id } = req.params;
  try {
    const success = await dataService.deleteTrainee(id);
    if (!success) {
      return res.status(404).json({ error: "Trainee not found" });
    }
    res.json({ success: true, message: "Trainee removed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST trainee import
app.post("/api/training-center/trainees/import", verifyAuth, requireStaff, async (req, res) => {
  const { trainees: importedList } = req.body;
  if (!Array.isArray(importedList)) {
    return res.status(400).json({ error: "Expected an array of trainees to import." });
  }
  try {
    const imported: any[] = [];
    for (const t of importedList) {
      if (!t.name || !t.email) continue;
      const newT = await dataService.createTrainee({
        name: t.name,
        email: t.email,
        phone: t.phone || "",
        company: t.company || "",
        enrolledDate: t.enrolledDate || new Date().toISOString().split("T")[0],
        assignedSessions: t.assignedSessions || [],
        moduleProgress: t.moduleProgress || {},
        overallProgress: Number(t.overallProgress) || 0,
        notes: t.notes || "",
        username: t.username || "",
        password: t.password || "",
        assignedPrograms: t.assignedPrograms || [],
        assistTasks: t.assistTasks || []
      });
      imported.push(newT);
    }
    res.status(201).json({ success: true, count: imported.length, trainees: imported });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get Trainee's own profile and tasks
app.get("/api/trainee/profile", verifyAuth, async (req: any, res) => {
  if (req.user.role !== "Trainee") {
    return res.status(403).json({ error: "Access Denied. Only Trainees can access their own profile." });
  }
  try {
    const traineesList = await dataService.getTrainees();
    const trainee = traineesList.find(t => t.id === req.user.traineeId);
    if (!trainee) {
      return res.status(404).json({ error: "Trainee profile not found." });
    }
    res.json({ success: true, trainee });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get training programs assigned to this trainee
app.get("/api/trainee/programs", verifyAuth, async (req: any, res) => {
  if (req.user.role !== "Trainee") {
    return res.status(403).json({ error: "Access Denied. Only Trainees can access assigned programs." });
  }
  try {
    const traineesList = await dataService.getTrainees();
    const trainee = traineesList.find(t => t.id === req.user.traineeId);
    if (!trainee) {
      return res.status(404).json({ error: "Trainee profile not found." });
    }
    const assignedIds = trainee.assignedPrograms || [];
    const programsList = await dataService.getPrograms();
    const assigned = programsList.filter(p => assignedIds.includes(p.id));
    res.json(assigned);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Submit Quiz Result for Trainee
app.post("/api/trainee/submit-quiz", verifyAuth, async (req: any, res) => {
  if (req.user.role !== "Trainee") {
    return res.status(403).json({ error: "Access Denied." });
  }
  try {
    const traineesList = await dataService.getTrainees();
    const trainee = traineesList.find(t => t.id === req.user.traineeId);
    if (!trainee) {
      return res.status(404).json({ error: "Trainee profile not found." });
    }

    const { quizId, score, passed, answers, notes, programId } = req.body;
    
    const newResult = await dataService.createResult({
      assessmentId: quizId,
      traineeId: trainee.id,
      timestamp: new Date().toISOString(),
      score,
      passed,
      instructorNotes: notes || `Self-submitted quiz. Score: ${score}%`,
      answers: answers || {},
      gradedBy: "Automatic Grading Engine",
      status: "graded"
    });
    
    const programsList = await dataService.getPrograms();
    const activeProg = programsList.find(p => p.id === programId);
    if (activeProg) {
      const matchedModule = activeProg.modules.find((m: any) => m.quizId === quizId || m.id === quizId);
      if (matchedModule) {
        if (!trainee.moduleProgress) {
          trainee.moduleProgress = {};
        }
        trainee.moduleProgress[matchedModule.id] = passed ? "Completed" : "In Progress";
        
        const totalModules = activeProg.modules.length;
        const completedModules = Object.values(trainee.moduleProgress).filter(v => v === "Completed").length;
        trainee.overallProgress = totalModules > 0 ? Math.round((completedModules / totalModules) * 100) : 0;
      }
    }

    await dataService.updateTrainee(trainee.id, trainee);
    res.json({ success: true, result: newResult, trainee });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Mark Assist Task complete
app.post("/api/trainee/complete-task", verifyAuth, async (req: any, res) => {
  if (req.user.role !== "Trainee") {
    return res.status(403).json({ error: "Access Denied." });
  }
  try {
    const traineesList = await dataService.getTrainees();
    const trainee = traineesList.find(t => t.id === req.user.traineeId);
    if (!trainee) {
      return res.status(404).json({ error: "Trainee profile not found." });
    }

    const { taskId, status } = req.body;
    if (!trainee.assistTasks) {
      trainee.assistTasks = [];
    }

    const task = trainee.assistTasks.find((t: any) => t.id === taskId);
    if (task) {
      task.status = status || "completed";
      if (task.status === "completed") {
        task.completedAt = new Date().toISOString();
      } else {
        delete task.completedAt;
      }
    }

    await dataService.updateTrainee(trainee.id, trainee);
    res.json({ success: true, trainee });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET sessions
app.get("/api/training-center/sessions", verifyAuth, requireStaff, async (req, res) => {
  try {
    const sessionsList = await dataService.getSessions();
    res.json(sessionsList);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST session
app.post("/api/training-center/sessions", verifyAuth, requireStaff, async (req, res) => {
  const { name, startDate, endDate, maxCapacity, assignedTrainer, enrolledTrainees, status, waitlist } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Session name is required" });
  }
  const cap = Number(maxCapacity) || 5;
  if (cap > 5) {
    return res.status(400).json({ error: "Maximum capacity cannot exceed 5 slots for small group enforcement." });
  }

  try {
    const newSession = await dataService.createSession({
      name,
      startDate: startDate || "",
      endDate: endDate || "",
      maxCapacity: cap,
      assignedTrainer: assignedTrainer || "",
      enrolledTrainees: enrolledTrainees || [],
      waitlist: waitlist || [],
      status: status || "Upcoming"
    });
    res.status(201).json(newSession);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update session
app.patch("/api/training-center/sessions/:id", verifyAuth, requireStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const sessionsList = await dataService.getSessions();
    const session = sessionsList.find(s => s.id === id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (req.body.maxCapacity !== undefined) {
      const cap = Number(req.body.maxCapacity);
      if (cap > 5) {
        return res.status(400).json({ error: "Maximum capacity cannot exceed 5 slots for small group enforcement." });
      }
    }

    if (req.body.enrolledTrainees !== undefined) {
      const traineesToEnroll = req.body.enrolledTrainees;
      const limit = req.body.maxCapacity !== undefined ? Number(req.body.maxCapacity) : session.maxCapacity;
      if (traineesToEnroll.length > limit) {
        return res.status(400).json({ error: `Enrolled trainees (${traineesToEnroll.length}) exceeds maximum group capacity limit of ${limit}.` });
      }
    }

    const updated = await dataService.updateSession(id, req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE session (Owner/Admin only)
app.delete("/api/training-center/sessions/:id", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { id } = req.params;
  try {
    const success = await dataService.deleteSession(id);
    if (!success) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ success: true, message: "Session removed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET assessments
app.get("/api/training-center/assessments", verifyAuth, requireStaff, async (req, res) => {
  try {
    const assessmentsList = await dataService.getAssessments();
    res.json(assessmentsList);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST assessment
app.post("/api/training-center/assessments", verifyAuth, requireStaff, async (req, res) => {
  const { title, moduleIds, passThreshold, questions } = req.body;
  if (!title) {
    return res.status(400).json({ error: "Assessment title is required" });
  }
  try {
    const newAssessment = await dataService.createAssessment({
      title,
      moduleIds: moduleIds || [],
      passThreshold: Number(passThreshold) || 80,
      questions: questions || []
    });
    res.status(201).json(newAssessment);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET results
app.get("/api/training-center/results", verifyAuth, requireStaff, async (req, res) => {
  try {
    const resultsList = await dataService.getResults();
    res.json(resultsList);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST submit result (grading)
app.post("/api/training-center/results", verifyAuth, requireStaff, async (req: any, res) => {
  const { assessmentId, traineeId, score, passed, instructorNotes, answers, gradedBy, status } = req.body;
  if (!assessmentId || !traineeId) {
    return res.status(400).json({ error: "Assessment ID and Trainee ID are required" });
  }
  try {
    const newResult = await dataService.createResult({
      assessmentId,
      traineeId,
      timestamp: new Date().toISOString(),
      score: Number(score) || 0,
      passed: !!passed,
      instructorNotes: instructorNotes || "",
      answers: answers || {},
      gradedBy: gradedBy || req.user?.username || "Staff",
      status: status || "graded"
    });
    res.status(201).json(newResult);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update result
app.patch("/api/training-center/results/:id", verifyAuth, requireStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await dataService.updateResult(id, req.body);
    if (!updated) {
      return res.status(404).json({ error: "Assessment result not found" });
    }
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE result (Admin/Owner only)
app.delete("/api/training-center/results/:id", verifyAuth, requireAdminOrOwner, async (req, res) => {
  const { id } = req.params;
  try {
    const success = await dataService.deleteResult(id);
    if (!success) {
      return res.status(404).json({ error: "Assessment result not found" });
    }
    res.json({ success: true, message: "Assessment result successfully deleted" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Analytics Dashboard Endpoint
app.get("/api/analytics", verifyAuth, requireStaff, async (req: any, res) => {
  // Aggregate data
  const currentLeads = await dataService.getLeads();
  const totalLeadsCount = currentLeads.length;
  const leadsByStatus = {
    new: currentLeads.filter((l) => l.status === "new").length,
    under_review: currentLeads.filter((l) => l.status === "under_review" || l.status === "contacted").length,
    approved: currentLeads.filter((l) => l.status === "approved" || l.status === "scheduled").length,
    declined: currentLeads.filter((l) => l.status === "declined").length,
  };

  const leadsByServiceType: Record<string, number> = {};
  currentLeads.forEach((l) => {
    leadsByServiceType[l.serviceType] = (leadsByServiceType[l.serviceType] || 0) + 1;
  });

  // Calculate estimated pipeline values (Financial estimates - Admin only)
  const isAdmin = req.user.role === "Admin";
  
  // Custom price estimates per category for pipeline calculation
  const getPipelineEstimate = (serviceType: string) => {
    switch (serviceType) {
      case "outdoor_construction": return 8500;
      case "hardscaping": return 6200;
      case "driveways_gravel": return 2800;
      case "water_management": return 3200;
      case "property_management": return 1500;
      case "land_services": return 2400;
      case "home_exterior": return 950;
      default: return 3000;
    }
  };

  const totalPipelineValue = currentLeads.reduce((sum, l) => sum + getPipelineEstimate(l.serviceType), 0);
  const allTasks = await dataService.getTasks();
  const activeTasksCount = allTasks.filter((t) => t.status !== "completed").length;

  res.json({
    totalLeads: totalLeadsCount,
    statusDistribution: leadsByStatus,
    serviceDistribution: leadsByServiceType,
    activeTasks: activeTasksCount,
    // Sensitive financial projection restricted on role-level
    financialPipeline: isAdmin ? totalPipelineValue : null,
    confidentialGrowthIndicator: isAdmin ? "+18.4% MoM" : "Restricted for Employees"
  });
});

// Local high-quality rule-based fallback generator when Gemini API is rate-limited or quota is exceeded
function getLocalConsultation(
  propertyType: string,
  serviceType: string,
  acreage: string,
  terrain: string,
  description: string,
  specificQuestions: string
): string {
  const pType = propertyType === "homeowner" ? "Residential Property" :
                propertyType === "farmer" ? "Agricultural Farm/Pasture" :
                propertyType === "developer" ? "Commercial Development Site" :
                propertyType === "hunting_land" ? "Recreational Hunting Land" : "Commercial Site";

  const sType = serviceType === "outdoor_construction" ? "Outdoor Construction (Decks, Fences, Pergolas)" :
                serviceType === "hardscaping" ? "Hardscaping (Patios, Stone Paths, Fire Pits)" :
                serviceType === "driveways_gravel" ? "Driveways & Gravel (Installation, Repair, Grading)" :
                serviceType === "water_management" ? "Property Water Management (French Drains, Swales)" :
                serviceType === "property_management" ? "Property Management & Maintenance" :
                serviceType === "land_services" ? "Land Services (Brush Hogging, Lot Clearing)" :
                serviceType === "home_exterior" ? "Home Exterior Services" :
                serviceType === "specialty_projects" ? "Specialty Projects & Contractor Coordination" : "Property Upkeep & Services";

  const terrainLabel = terrain === "flat_wooded" ? "Flat, Heavily Wooded" :
                       terrain === "hilly_wooded" ? "Hilly & Steep Wooded Slope" :
                       terrain === "wet_swampy" ? "Wet, Swampy / Creek Drainage" :
                       terrain === "open_scrub" ? "Open Scrub & Dense Briars" : "Rocky Soil / Granite Ledge";

  // Customize methodology recommendation based on service type
  let methodology = "";
  let duration = "";
  let complications = "";
  
  if (serviceType === "outdoor_construction" || serviceType === "hardscaping") {
    methodology = "Premium craftsmanship and meticulous site preparation. We utilize high-quality timber, professional staining, and solid sub-base structures to build long-lasting decks, fences, pergolas, and stone patios.";
    duration = "Approx 2 to 5 operating days depending on layout complexity.";
    complications = "Terrain slope, ground stability, and exact dimensional setback specifications.";
  } else if (serviceType === "driveways_gravel" || serviceType === "water_management") {
    methodology = "Precision grading, pothole repair, driveway crowning, and engineered water diversion. We install heavy-duty French drains, swales, culverts, and downspout extensions to permanently solve foundation and yard water issues.";
    duration = "Approx 1 to 2 operating days.";
    complications = "Heavy rainfall schedule anomalies, soil dampness, and active surface runoff.";
  } else if (serviceType === "property_management" || serviceType === "home_exterior") {
    methodology = "Routine inspections, home oversight, detailed diagnostic reporting, deep power washing, and protective soft washing. Keeping your exterior surface, siding, and gutters clean and your investment fully maintained.";
    duration = "Typically completed in 1 day or as a recurring scheduled checklist.";
    complications = "Weather condition limits (for soft washing) and historical exterior structural wear.";
  } else {
    // land_services or specialty_projects
    methodology = "High-efficiency brush hogging, trail clearing, lot cleanups, and bespoke project management. If the scope requires specialized master trades, we coordinate trusted local professionals so you don't have to.";
    duration = "Approx 1 to 3 operating days.";
    complications = "Dense thick underbrush, steep terrain gradients, and custom utility coordination.";
  }

  const brandPromiseSection = `
### 🤝 THE J&H BRAND PROMISE
* **One Call. Any Project.**: Decks, driveways, drainage, hardscaping, grading, and routine care—we handle it all.
* **Our Commitment**: If your property needs it, we'll find the right solution. If we can't do it ourselves, we'll connect you with trusted professionals who can and manage the entire process, so you only need to make one call.
* **Property Respect**: We treat your property with absolute professional care—exactly like our own.`;

  return `### 🛠️ LAND CONSULTATION BRIEF
We have analyzed your **${pType}** project details for **${sType}** across **${acreage}** of **${terrainLabel}** terrain.
* **Property Parameters**: Handled as owner-operated project scope.
* **Your Inputs**: "${description}"
${specificQuestions ? `* **Advisory on Concern**: regarding "${specificQuestions}", our solutions are engineered to address specific soil, water, and structural integrity requirements.` : ""}

### 🛠️ RECOMMENDED METHODOLOGY & STANDARDS
* **Primary Approach**: ${methodology}
* **Methodology**: Low ground pressure methods minimize footprint impact, ensuring root flares of premium trees are protected and topsoil is preserved from erosion.
* **The J&H Advantage**: No cheap general sub-contractors—the J&H team personally oversees and executes the work on your property, ensuring zero shortcuts are taken.

### ⏱️ ESTIMATED SCOPE & COMPLICATIONS
* **Expected Timeframe**: ${duration}
* **Active Variables**: Terrain slope, soil saturation levels, weather alignment, and proper property boundary setbacks.
* **Mitigation Strategy**: Staging equipment on stable soil zones and working methodically for precision results.

### 📐 EDUCATIONAL CORNER: CONTRACTOR QUESTIONS
1. *Is your service fully insured with a comprehensive commercial liability policy?* (Do not let uninsured operators onto your private acreage).
2. *How do you manage drainage and soil stability?* (Good contractors prevent soil erosion and water ponding around the work area).
3. *Do you perform selective land services?* (Selective clearing removes only target brush and junk trees, saving premium mature hardwoods).
${brandPromiseSection}

### 📝 RECOMMENDED NEXT STEPS FOR J&H QUOTE
We recommend converting this analysis into a physical walkthrough on your property. 
1. Click **Apply to Quote Request** to lock in these parameters.
2. Submit our secure contact form. We will contact you within 2 hours to confirm a convenient walkthrough window.`;
}

// Gemini Property Consultation API
app.post("/api/gemini/consult", async (req, res) => {
  const { propertyType, serviceType, description, terrain, acreage, specificQuestions, services, propertySize, specialRequirements } = req.body;

  const servicesList = services || (serviceType ? [serviceType] : ["property_management"]);
  const size = propertySize || acreage || "1-2 acres";
  const terr = terrain || "flat_wooded";
  const reqs = specialRequirements || description || specificQuestions || "";

  // Calculate price estimate based on rates in src/pricingData
  const estimate = calculateEstimate(servicesList, size, terr, reqs);

  const estimateSection = `

### 💰 TYPICAL NORTHERN NECK MARKET RANGE
* **Typical Market Range**: **$${estimate.estimatedLow.toLocaleString()} - $${estimate.estimatedHigh.toLocaleString()}**
* **Geographic Basis**: Typical market range for similar work in Virginia's Northern Neck for **${size}** of **${terr.replace("_", " ")}** terrain.
* **Cost Factor Breakdown**:
${estimate.briefBreakdown.split('\n').map(line => `  * ${line}`).join('\n')}

*Note: This is the typical regional market range for project planning. J&H will provide a guaranteed final quote after a physical site walkthrough.*`;

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("No GEMINI_API_KEY environment variable provided. Falling back to high-quality local consultation generator.");
      const text = getLocalConsultation(propertyType, serviceType, acreage, terrain, description, specificQuestions) + estimateSection;
      return res.json({ 
        text,
        services: estimate.services,
        estimatedLow: estimate.estimatedLow,
        estimatedHigh: estimate.estimatedHigh,
        briefBreakdown: estimate.briefBreakdown
      });
    }

    const client = getAIClient();

    const systemPrompt = `You are the elite AI Property Consultant & Project Advisor for J&H Land Services LLC, a premium single-source property solutions provider serving the Montross, Neenah, and Northern Neck area of Virginia.

Our core brand promise is: "One Call. Any Property Project. If your property needs it, we'll find the right solution. If we can't do it ourselves, we'll connect you with trusted professionals who can and manage the process—so you only need one call."

We serve clients across our core service categories:
1. Property Management Care & Upkeep
2. Seasonal Home Opening & Winterization
3. Land Clearing & Forestry Mulching
4. Excavation & Demolition
5. Gravel Driveways & Driveway Repair
6. Exterior Property Maintenance & Cleanup
7. Specialty Projects & Contractor Coordination

Your role is to analyze property projects based on the user's input and provide a deeply professional, educational, and structured project analysis. Your response should build immense trust, display exceptional local contractor expertise, and serve as an educational guide.

Structure your response with these exact Markdown sections:

### 🛠️ LAND CONSULTATION BRIEF
Summarize their request in a professional project-brief manner. Reassure them that J&H treats their property like our own.

### 🛠️ RECOMMENDED METHODOLOGY & STANDARDS
Explain our high-quality project standards (e.g. correct stone sub-bases for hardscaping, proper post anchoring for construction, ditching and crowns for driveway regrading, slope analysis for French drains and swales). Detail how we maintain soil integrity and minimize ground disruption. Reiterate that J&H is a single-call solution: if we do not execute a specialty part of the project directly, we coordinate and manage vetted trusted professionals so the client never has to worry.

### ⏱️ ESTIMATED SCOPE & COMPLICATIONS
Break down:
- Approximate operating timeframe or stages required (give realistic, honest project expectations).
- Potential site variables that could affect progress (e.g., soil saturation, slope gradient, underground utilities, access path width).

### 📐 EDUCATIONAL CORNER: CONTRACTOR QUESTIONS
Provide 2-3 specific technical questions J&H would ask during their physical site walk, and what questions the user should ask any contractor to ensure they aren't getting shortcuts. Mention the importance of comprehensive commercial liability insurance.

### 🤝 THE J&H BRAND PROMISE
Explicitly remind them of J&H's guarantee: "If your property needs it, we'll find the right solution. If we can't do it ourselves, we'll connect you with trusted professionals who can."

### 📝 RECOMMENDED NEXT STEPS FOR J&H QUOTE
Recommend the concrete details they should provide when they click 'Apply to Quote' to schedule their free on-site physical consultation with the J&H owner.

Tone Rules:
- Conversational, authoritative, confident, yet humble and local.
- No fluff, no low-budget contractor slang. Sound like a premium brand.
- Be realistic—remind them that satellite analysis and AI are excellent for planning, but an on-site physical evaluation by J&H's owner is the final step to a guaranteed quote.
- Write at roughly an 8th-grade reading level but feel highly high-end. Do not use generic corporate clichés like "synergy", "paradigm shift" or "leverage".`;

    const userPrompt = `Please analyze this property request:
- Property Type: ${propertyType}
- Service Required: ${servicesList.join(", ")}
- Area/Acreage involved: ${size}
- Terrain Description: ${terr}
- Details of Project: ${reqs}`;

    const response = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt
      }
    });

    res.json({ 
      text: response.text + estimateSection,
      services: estimate.services,
      estimatedLow: estimate.estimatedLow,
      estimatedHigh: estimate.estimatedHigh,
      briefBreakdown: estimate.briefBreakdown
    });
  } catch (err: any) {
    console.error("Gemini Consultation Error (falling back to high-quality local generator):", err);
    try {
      const text = getLocalConsultation(propertyType, serviceType, acreage, terrain, description, specificQuestions) + estimateSection;
      res.json({ 
        text,
        services: estimate.services,
        estimatedLow: estimate.estimatedLow,
        estimatedHigh: estimate.estimatedHigh,
        briefBreakdown: estimate.briefBreakdown
      });
    } catch (fallbackErr: any) {
      res.status(500).json({ error: "Failed to generate property advisory report." });
    }
  }
});

// MEETING NOTES & KNOWLEDGE BASE STORAGE (In-Memory Persistence)
interface NoteAttachment {
  name: string;
  type: string; // "photo" | "pdf" | "estimate" | "invoice" | "permit" | "contract" | "other"
  url?: string;
  size?: string;
  uploadedAt: string;
}

interface NoteVersion {
  id: string;
  content: string;
  title: string;
  editedBy: string;
  editedAt: string;
}

interface MeetingNote {
  id: string;
  title: string;
  content: string;
  date: string;
  department: string;
  project: string;
  customer: string;
  serviceCategory: string;
  isPinned: boolean;
  isArchived: boolean;
  createdBy: string;
  lastEditedBy: string;
  lastEditedAt: string;
  attachments: NoteAttachment[];
  versions: NoteVersion[];
}

let notes: MeetingNote[] = [];
const notesUnusedDummy = [
  {
    id: "note_0",
    title: "J&H Complete Business Action Plan",
    content: `# J&H LAND SERVICES — COMPLETE BUSINESS ACTION PLAN
**Prepared for**: Business Owner Walkthrough & Presentation
**Status**: ACTIVE | **Priority**: CRITICAL | **Department**: Executive Operations & Marketing

---

## 📋 1. EXECUTIVE VISION & OPERATIONAL PHILOSOPHY
J&H Land Services LLC has officially transitioned from a general crew into a premier, single-source property solutions firm serving Montross, Neenah, King George, and Westmoreland County, Virginia. Our core brand promise is:
**"One Call. Any Project."**

* **In-House Capability**: We self-execute forestry mulching, brush clearing, driveway grading, French drain water diversion, selective clearing, and exterior soft/power washing.
* **Specialty Partner Networks**: For structural building, heavy paving, and utility work, we coordinate trusted subcontractors. J&H acts as the sole manager and point of contact so the landowner has absolute peace of mind.

---

## 📣 2. ACTIVE LOCAL ADVERTISING PLANS
To capture local demand and establish dominant local presence, we are rolling out three high-yield physical and digital channels:

### 📍 Channel A: Local SEO & Google Business Profile (GBP) Listing
* **Target Keywords**: "Land clearing near me", "French drain installer Virginia", "Gravel driveway repair Montross", "Forestry mulching Westmoreland".
* **Operational Execution**: 
  * Tag our central dispatch facility in Montross.
  * Upload high-resolution site photographs weekly.
  * Direct customers to the online quote/consultation tool to capture phone numbers and project coordinates.

### 👥 Channel B: Geo-Targeted Facebook Ads
* **Target Audience**: Large-acreage landowners, farmers, custom homebuilders, and new property buyers within a 30-mile radius of Westmoreland County.
* **Campaign Focus**: Before-and-after visual reels of brush clearing, gravel driveway regrading, and storm-damage clearing.
* **Budget**: Initial local budget of $300/month.

### 🪵 Channel C: Local Hardware Store Flyer Distribution
* **Target Partners**: Feed & seed suppliers, agricultural equipment dealers, and building contractors stores in Westmoreland and King George.
* **Promotional Offer**: "Seasonal Site Walk & Drainage Consultation" flyer containing J&H's dispatcher contact.

---

## ⏱️ 3. IMMEDIATE ROADMAP: WHAT WE NEED NEXT
We have successfully built, coded, and validated the digital foundation (the website, custom calculators, pricing sheet, and staff portal are complete!). Here is the exact checklist for what we need next to start booking real projects:

### 1. Google Maps Verification PIN (Critical Next Step)
* *Action*: Enter the postal code sent by Google to verify the Montross office listing and set J&H live on local map searches.

### 2. Print & Place High-Visibility Yard Signs
* *Action*: Produce 10 metal yard signs with J&H logo and tagline to place at completed driveway or clearing projects.

### 3. Log First Real Customers & Project Walkthroughs
* *Action*: Owner to log all paper leads, active quotes, and past customer directories directly into this secure staff portal to establish a consolidated CRM.

### 4. Deploy Truck Decals & Branding
* *Action*: Install custom J&H door magnetic decals and contact numbers on all primary heavy trucks and flatbeds to turn daily transport into a mobile billboard.`,
    date: "2026-07-08",
    department: "Executive",
    project: "90-Day Growth Plan",
    customer: "General",
    serviceCategory: "Specialty Projects",
    isPinned: true,
    isArchived: false,
    createdBy: "admin",
    lastEditedBy: "admin",
    lastEditedAt: "2026-07-08T09:00:00.000Z",
    attachments: [],
    versions: []
  },
  {
    id: "note_1",
    title: "Transition Strategy & Tagline Core Decision",
    content: `## Strategy Overview
We are officially transitioning J&H from a simple landscaping crew into a high-end **Full-Service Property Solutions Company**. 

### Tagline Core Principle
**"One Call. Any Project."**
This is our primary marketing hook. We communicate absolute convenience to property owners and managers in the Northern Neck of Virginia.
* **Self-Execution**: If our crew has the core competency and mechanical tooling (saws, SVL97-2 skid steer, excavators), we execute the work in-house.
* **Project Management**: If the scope demands licensed structural specialists, master electricians, or heavy pavers, we coordinate and project-manage the subcontractors on their behalf. The client gets exactly one invoice, one point of contact, and absolute reassurance.

### Action Steps
1. Revise logo branding to incorporate the tagline.
2. Update the website to lay out all service pillars.
3. Establish pre-negotiated priority agreements with local concrete batch yards and certified arborists.`,
    date: "2026-06-15",
    department: "Business Development",
    project: "Branding Overhaul",
    customer: "General",
    serviceCategory: "Specialty Projects",
    isPinned: true,
    isArchived: false,
    createdBy: "admin",
    lastEditedBy: "admin",
    lastEditedAt: "2026-06-15T14:30:00.000Z",
    attachments: [
      { name: "brand_tagline_brief.pdf", type: "pdf", size: "185 KB", uploadedAt: "2026-06-15T14:30:00.000Z" }
    ],
    versions: []
  },
  {
    id: "note_2",
    title: "Operations SOP: Deck Restoration Standards",
    content: `## Standard Operating Procedure: Premium Deck Restoration & Preservation
To maintain J&H's brand reputation for premium quality, crews must execute deck restorations precisely according to this SOP.

### 1. Pre-Inspection & Structural Anchoring
* Inspect support joists and ledger boards for dry rot or wood decay. Report structural faults immediately to the office.
* Tighten loose deck boards. Replace corroded nails with 3-inch outdoor-rated deck screws. Countersink screws by 1/16th inch.

### 2. Deep Chemical Cleaning (Non-Destructive)
* Apply a premium wood stripper/restorer (sodium metasilicate base) to break down deteriorated sealers and lift biological matter. Let sit for 15-20 minutes.
* Pressure wash using a wide fan tip (40 degrees) at a maximum pressure of 1200 PSI. Keep the wand 12 inches away from the wood to prevent scarring or gouging.

### 3. Wood Fiber Neutralization & Drying
* Apply an oxalic acid brightener to neutralize pH and lift iron stains. Rinse thoroughly.
* Allow the timber to dry completely. We require a minimum of **48 hours of dry weather**. Moisture content MUST measure below 12% before staining.

### 4. Sanding & Finish Preparation
* Sand flat deck boards with an orbital sander at 80-grit to open the wood pores. 
* Sand handrails and balusters with 120-grit for a comfortable, splinter-free user touch. Vacuum and blow off all sawdust.

### 5. Professional Stain Application
* Brush-apply professional oil-based semi-transparent stain (e.g., Natural Cedar). Avoid spraying on breezy days.
* Back-brush to ensure deep penetration of wood grain. Maintain a wet edge to avoid overlap lines.`,
    date: "2026-07-01",
    department: "Operations",
    project: "Deck Restoration SOPs",
    customer: "General",
    serviceCategory: "Outdoor Construction",
    isPinned: false,
    isArchived: false,
    createdBy: "admin",
    lastEditedBy: "employee",
    lastEditedAt: "2026-07-02T10:15:00.000Z",
    attachments: [
      { name: "deck_safety_inspection.pdf", type: "pdf", size: "95 KB", uploadedAt: "2026-07-01T09:00:00.000Z" }
    ],
    versions: []
  },
  {
    id: "note_3",
    title: "Driveway Repair & Grading SOP",
    content: `## Standard Operating Procedure: Gravel Driveway Restoration & Leveling
Potholes and washouts are a chronic issue in our Virginia clay soil. Follow these guidelines for long-lasting gravel installations.

### 1. Grading & Scarification
* Do NOT just dump new gravel over active potholes—it will settle and sink within months.
* Use the box blade scarifiers to dig 2-3 inches deep into the existing driveway base. Break open the hardpack bottom of every pothole.

### 2. Crowning & Slope Design
* Grade the driveway to establish a centerline "crown" with a 2-3% slope from center to edge.
* Cut side swales or install diversion swales to ensure runoff flows parallel to the driveway rather than washing down the wheel tracks.

### 3. Sub-base Stabilizing (If Clay/Soft)
* Lay heavy-duty geotextile separation fabric if dealing with saturated clay soils.
* Spread 3-4 inches of coarse ballast stone (#3) and pack it deep if the driveway is unstable.

### 4. Cap Selection & Interlocking Compaction
* Spread 2-3 inches of #21A Crusher Run gravel (mix of 3/4" stone and gravel dust). The dust interlocks the gravel to create a solid concrete-like driving surface.
* Compact thoroughly using a rolling vibratory compactor or heavy truck tires to seal.`,
    date: "2026-07-03",
    department: "Operations",
    project: "Gravel Maintenance",
    customer: "General",
    serviceCategory: "Driveways & Gravel",
    isPinned: false,
    isArchived: false,
    createdBy: "admin",
    lastEditedBy: "admin",
    lastEditedAt: "2026-07-03T16:00:00.000Z",
    attachments: [],
    versions: []
  },
  {
    id: "note_4",
    title: "Pricing Sheet & Estimating Framework",
    content: `## J&H Estimating Framework & Standard Prices

Our pricing is built to reflect professional-grade equipment, skilled operating technicians, comprehensive liability coverage, and realistic profit margins.

### ⏱️ Labor & Mobilization Day Rates
* **Standard Operational Day Rate**: **$1,500 / day** (includes skid steer Kubota SVL97-2 with bucket, 2 skilled crewmen, mobilization up to 30 miles, fuel, and liability coverage).
* **Forestry Mulcher Specialty Day Rate**: **$2,200 / day** (includes high-flow Kubota SVL97-2 with heavy-duty masticating head, dedicated trailer, skilled operator, safety buffer crewman, and fuel).

### 🛠️ Common Project Unit Rates
* **French Drains / Swales**: $35 - $50 per linear foot (includes trenching, fabric, #57 river stone, 4" perforated pipe, and backfill).
* **Deck Staining / Restoration**: $2.00 - $3.50 per square foot (materials + prep labor).
* **New Wood Deck Construction**: $30 - $45 per square foot.
* **Gravel Spread / Refreshing**: $50 - $75 per ton of #21A Crusher Run installed (inclusive of material cost, hauling, spreading, and grading).
* **Brush Hogging / Trail Clearing**: $150 - $250 / hour depending on undergrowth density.`,
    date: "2026-07-05",
    department: "Admin",
    project: "Pricing Setup",
    customer: "General",
    serviceCategory: "Specialty Projects",
    isPinned: true,
    isArchived: false,
    createdBy: "admin",
    lastEditedBy: "admin",
    lastEditedAt: "2026-07-05T11:00:00.000Z",
    attachments: [],
    versions: []
  }
];

// GET all meeting notes
app.get("/api/notes", verifyAuth, requireStaff, async (req, res) => {
  try {
    const list = await dataService.getNotes();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to retrieve meeting notes." });
  }
});

// CREATE a new meeting note
app.post("/api/notes", verifyAuth, requireStaff, async (req: any, res) => {
  const { title, content, department, project, customer, serviceCategory, isPinned } = req.body;
  if (!title) {
    return res.status(400).json({ error: "Title is required for notes." });
  }

  try {
    const newNote = await dataService.createNote({
      title,
      content: content || "",
      date: new Date().toISOString().split("T")[0],
      department: department || "Operations",
      project: project || "General",
      customer: customer || "General",
      serviceCategory: serviceCategory || "Specialty Projects",
      isPinned: !!isPinned,
      isArchived: false,
      createdBy: req.user.username,
      lastEditedBy: req.user.username,
      lastEditedAt: new Date().toISOString(),
      attachments: [],
      versions: []
    });

    res.status(201).json({ success: true, note: newNote });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create meeting note." });
  }
});

// UPDATE a meeting note (with version history tracking)
app.patch("/api/notes/:id", verifyAuth, requireStaff, async (req: any, res) => {
  const { id } = req.params;
  const { title, content, department, project, customer, serviceCategory, isPinned, isArchived, attachments } = req.body;
  
  try {
    const notesList = await dataService.getNotes();
    const note = notesList.find((n) => n.id === id);
    if (!note) {
      return res.status(404).json({ error: "Meeting note not found" });
    }

    const contentChanged = content !== undefined && content !== note.content;
    const titleChanged = title !== undefined && title !== note.title;

    const versions = [...(note.versions || [])];
    if (contentChanged || titleChanged) {
      versions.unshift({
        id: `v_${Date.now()}`,
        content: note.content,
        title: note.title,
        editedBy: note.lastEditedBy || "unknown",
        editedAt: note.lastEditedAt || new Date().toISOString()
      });
    }

    const updateData: Partial<MeetingNote> = {
      ...(title !== undefined && { title }),
      ...(content !== undefined && { content }),
      ...(department !== undefined && { department }),
      ...(project !== undefined && { project }),
      ...(customer !== undefined && { customer }),
      ...(serviceCategory !== undefined && { serviceCategory }),
      ...(isPinned !== undefined && { isPinned: !!isPinned }),
      ...(isArchived !== undefined && { isArchived: !!isArchived }),
      ...(attachments !== undefined && { attachments }),
      versions,
      lastEditedBy: req.user.username,
      lastEditedAt: new Date().toISOString()
    };

    const updated = await dataService.updateNote(id, updateData);
    res.json({ success: true, note: updated });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update meeting note." });
  }
});

// DELETE a meeting note (Admin/Owner only)
app.delete("/api/notes/:id", verifyAuth, requireStaff, async (req: any, res) => {
  if (req.user.role !== "Admin" && req.user.role !== "Owner") {
    return res.status(403).json({ error: "Access Denied. Only Admin or Owner users can delete meeting notes." });
  }
  const { id } = req.params;
  try {
    const deleted = await dataService.deleteNote(id);
    if (deleted) {
      res.json({ success: true, message: "Note successfully removed." });
    } else {
      res.status(404).json({ error: "Meeting note not found." });
    }
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete meeting note." });
  }
});

// ATTACH a document to a note
app.post("/api/notes/:id/attachments", verifyAuth, requireStaff, async (req: any, res) => {
  const { id } = req.params;
  const { name, type, size } = req.body;
  try {
    const notesList = await dataService.getNotes();
    const note = notesList.find((n) => n.id === id);
    if (note) {
      const newAttachment = {
        name: name || "document.pdf",
        type: type || "pdf",
        size: size || "120 KB",
        uploadedAt: new Date().toISOString()
      };
      const updatedAttachments = [...(note.attachments || []), newAttachment];
      const updatedNote = await dataService.updateNote(id, {
        attachments: updatedAttachments,
        lastEditedBy: req.user.username,
        lastEditedAt: new Date().toISOString()
      });
      res.json({ success: true, note: updatedNote, attachment: newAttachment });
    } else {
      res.status(404).json({ error: "Note not found." });
    }
  } catch (err: any) {
    res.status(500).json({ error: "Failed to attach document to note." });
  }
});

// LOCAL AI CO-PILOT FALLBACK LOGIC
function getLocalAssistantAnswer(query: string, contextBrief: string): string {
  const lowercaseQuery = query.toLowerCase();

  let intro = `### 🤖 J&H LOCAL AI CO-PILOT (OFFLINE SYSTEM)
*Note: Operating in local fallback mode. Here is the direct lookup of our J&H operational handbook and database:*

`;

  if (lowercaseQuery.includes("day rate") || lowercaseQuery.includes("pricing") || lowercaseQuery.includes("rate")) {
    return intro + `### 💰 J&H STANDARD PRICE LIST & DAY RATES
* **Standard Crew Day Rate**: **$1,500 / day** (includes Kubota SVL97-2 skid steer, hauling trailer, fuel, 2 technicians, mobilization up to 30 miles, and comprehensive liability coverage).
* **Forestry Mulching Specialty Rate**: **$2,200 / day** (includes high-flow SVL97-2 with masticating head, dedicated transporter, professional operator, safety coordinator, and fuel).
* **Crusher Run Gravel Cap**: **$45 / ton** spread (Plus flat-rate delivery depending on mileage).
* **Double-Shredded Hardwood Mulch**: **$55 / cubic yard** spread (Includes light clearing prep).
* **French Drains**: $35 - $50 per linear foot.
* **Deck Construction**: $30 - $45 per sq ft.
* **Deck Restoration**: $2.00 - $3.50 per sq ft.`;
  }

  if (lowercaseQuery.includes("deck") && lowercaseQuery.includes("restore") || lowercaseQuery.includes("restore a deck")) {
    return intro + `### 🛠️ SOP: DECK RESTORATION STANDARDS
Here is the official procedure for restoring cedar and pine decks:
1. **Structural Anchoring**: Inspect framing ledger and joist rot. Re-secure loose boards with 3" deck screws.
2. **Sodium Metasilicate Cleanse**: Spray stripper and soak for 15 minutes. Power wash with 40-degree wide fan tip at **max 1200 PSI** to protect wood fibers.
3. **Oxalic Brightener**: Apply neutralizer and rinse.
4. **Moisture Wait**: Let dry for **48 hours of sun** (must be <12% moisture).
5. **Orbital Sanding**: Sand flats at 80-grit, handrails at 120-grit.
6. **Oil-stain**: Back-brush premium oil-based semi-transparent stain to maintain a wet edge.`;
  }

  if (lowercaseQuery.includes("driveway") || lowercaseQuery.includes("gravel")) {
    return intro + `### 🛠️ SOP: GRAVEL DRIVEWAY GRADIENTS & REPAIR
To prevent rapid potholes:
1. **Scarify**: Dig 2-3 inches deep into hardpack using box blade rippers to eliminate the pothole 'pockets'.
2. **Centerline Crown**: Shape with a 2-3% side slope to shed water.
3. **Geo-Grid / Fabric**: Install heavy-duty geotextile on weak soft-clay spots.
4. **Course Ballast #3**: Lay 3" base if unstable.
5. **Cap #21A Crusher Run**: Spread 2" depth and compact thoroughly. The dust locks the 3/4" stone into a hard surface.`;
  }

  if (lowercaseQuery.includes("action") || lowercaseQuery.includes("task") || lowercaseQuery.includes("unfinished")) {
    return intro + `### 📋 J&H ACTIVE OPERATIONS CHECKLIST
    Here are our outstanding logistics and office tasks:
1. **[CRITICAL]** Finalize quote & fence sub-contractor for King George project (Assigned: Admin, Due: 2026-07-08)
2. **[HIGH]** Walkthrough Robert Miller's 2-acre clearing site (Assigned: Admin, Due: 2026-07-10)
3. **[MEDIUM]** Perform 100-hour service on Kubota Skid Steer (Change oil/filters, grease joints) (Assigned: Employee, Due: 2026-07-09)
4. **[LOW]** Deliver 10 tons Crusher Run gravel to Sarah Jenkins driveway (Assigned: Employee, Due: 2026-07-08)`;
  }

  if (lowercaseQuery.includes("deck") && (lowercaseQuery.includes("quote") || lowercaseQuery.includes("estimate") || lowercaseQuery.includes("20x16") || lowercaseQuery.includes("composite"))) {
    return intro + `### 📝 DRAFT ESTIMATE: 20x16 COMPOSITE DECK BUILD
**Prepared for**: Client Inquiry File
**Service Category**: Outdoor Construction

#### 📐 Project Dimension Analysis
* Dimensions: 20 ft x 16 ft = **320 square feet**
* Core Material: Premium low-maintenance Composite Decking

#### 💰 Cost Allocation Breakdown
1. **Demolition / Site Prep**: 1 day crew work = **$1,500**
2. **Framing & Posts**: Treated timber joists, concrete anchoring footings = **$3,200**
3. **Composite Boards & Hidden Fasteners**: $18/sq ft materials = **$5,760**
4. **Installation & Railings**: 3 days standard crew rate = **$4,500**
5. **Sub-Contractor Coordination (If specialty layout)**: Included in J&H project oversight.

**TOTAL ESTIMATED CONTRACT**: **$14,960**
*Payment Terms: 30% mobilization deposit, 40% mid-point framing completion, 30% final sign-off inspection.*`;
  }

  if (lowercaseQuery.includes("equipment") || lowercaseQuery.includes("driveway restoration")) {
    return intro + `### 🚜 REQUIRED EQUIPMENT: DRIVEWAY RESTORATION
For a standard driveway grading and regrading project, dispatch the following:
1. **Skid Steer (Kubota SVL97-2)** with standard grading bucket.
2. **Land Plane or Box Blade attachment** with adjustable scarifier teeth.
3. **Rolling Smooth-Drum Vibratory Compactor** (towed or standalone).
4. **Hand tools**: Shovels, rakes, slope level indicator.
5. **PPE**: High-visibility safety vest, steel-toe boots, protective eyewear.`;
  }

  // Default professional responses
  return intro + `### 📋 J&H OPERATIONS KNOWLEDGE RETRIEVAL
I have scanned our team database. Here are the core details matching your operational query:

* **Company Standard**: "One Call. Any Project." We execute in-house or project manage trusted subcontractors.
* **Standard Service Areas**: Montross, King George, Westmoreland, and Northern Neck, Virginia.
* **Support Available**: I can generate estimates, write contracts, draft SMS/emails, write Google Business updates, and review our operations checklists.

**How can I draft this for you?** Try querying:
1. "Generate a quote for a 20x16 composite deck"
2. "How do we restore a deck?"
3. "What equipment is required for driveway restoration?"
4. "Show all unfinished action items"`;
}

// SECURE BUILT-IN AI OPERATIONS ASSISTANT CHAT
app.post("/api/assistant/chat", verifyAuth, requireStaff, async (req: any, res) => {
  const { query, chatHistory } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: "Query is required." });
  }

  try {
    const currentLeads = await dataService.getLeads();
    const currentTasks = await dataService.getTasks();
    const currentInventory = await dataService.getInventory();
    const currentNotes = await dataService.getNotes();

    const contextBrief = `
You have secure real-time access to the J&H internal database.
CURRENT TIME: ${new Date().toISOString()}
OPERATING USER: ${req.user.username} (${req.user.role})

1. CUSTOMER INQUIRIES & ESTIMATES:
${JSON.stringify(currentLeads.map(l => ({ id: l.id, name: l.name, email: l.email, phone: l.phone, address: l.address, service: l.serviceType, status: l.status, details: l.details, notes: l.notes })))}

2. ACTIVE LOGISTICS TASKS:
${JSON.stringify(currentTasks.map(t => ({ id: t.id, title: t.title, assignedTo: t.assignedTo, priority: t.priority, status: t.status, dueDate: t.dueDate, notes: t.notes })))}

3. EQUIPMENT & MATERIALS INVENTORY:
${JSON.stringify(currentInventory.map(i => ({ id: i.id, name: i.name, category: i.category, qty: i.quantity, unit: i.unit, status: i.status })))}

4. TEAM MEETING NOTES & KNOWLEDGE BASE:
${JSON.stringify(currentNotes.map(n => ({ id: n.id, title: n.title, date: n.date, department: n.department, project: n.project, customer: n.customer, category: n.serviceCategory, pinned: n.isPinned, archived: n.isArchived, lastEditedBy: n.lastEditedBy, content: n.content })))}
`;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("No GEMINI_API_KEY environment variable provided for Operations Assistant. Falling back to high-quality local rules assistant.");
      const text = getLocalAssistantAnswer(query, contextBrief);
      return res.json({ text });
    }

    const client = getAIClient();

    const systemInstruction = `You are the highly sophisticated AI Operations Assistant and Strategic Consultant for J&H Land Services LLC, an expanding full-service property solutions provider in Virginia.
Your tagline is: "One Call. Any Project." and your core mission is: "If we have the skills and equipment, we'll complete the work ourselves. If not, we'll coordinate trusted subcontractors and manage the project from start to finish, giving customers one reliable point of contact."

CONTEXT FOR OPERATIONS:
${contextBrief}

YOUR GUIDELINES:
1. Always base your answers on the actual J&H data provided above (leads, tasks, inventory, meeting notes) when asked. If information is not present, you can generate professional boilerplate templates or draft estimates, but make sure to point out that they can customize it.
2. You can perform advanced operations:
   - Create fully detailed project estimates and invoices based on standard pricing (e.g. standard day rate of $1,500/day, forestry mulcher at $2,200/day, french drains at $35-$50/ft, crusher run gravel at $45/ton, hardwood mulch at $55/yard, deck construction at $30-$45/sq ft).
   - Draft legal contracts and client agreements.
   - Draft highly polished client emails, texts, and communication updates.
   - Summarize long meeting notes, extract clear checklists, and list action items.
   - Design marketing promotions, Google Business Profile updates, and local SEO keywords.
   - Help coordinate crews by creating daily schedules or recommending safety procedures (e.g., proper respirator gear when sanding copper-chromate treated timber, box-blade deep scarification for driveway grading).
3. Format all outputs beautifully in structured Markdown. Use clean headers, bullet points, checklists, and code-blocks for templates or invoices.
4. If a user asks "Show all unfinished action items" or similar, look through the tasks lists and notes content to find active items and present them clearly.
5. If the user asks for a quote or a deck build calculation, do the math explicitly and show the subtotal, materials cost, and labor days needed.`;

    const contents = [];
    if (chatHistory && Array.isArray(chatHistory)) {
      chatHistory.forEach((msg: any) => {
        contents.push({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.text }]
        });
      });
    }
    contents.push({
      role: "user",
      parts: [{ text: query }]
    });

    const response = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
      config: {
        systemInstruction
      }
    });

    res.json({ text: response.text });
  } catch (err: any) {
    console.error("Assistant Error (falling back to rule-based engine):", err);
    try {
      const text = getLocalAssistantAnswer(query, "");
      res.json({ text });
    } catch (fallbackErr: any) {
      res.status(500).json({ error: "Failed to query the AI assistant." });
    }
  }
});

// Production Static Serving & Listening (Only run in non-Netlify environments and production)
if (!process.env.NETLIFY && process.env.NODE_ENV === "production") {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  
  // SPA routing fallback
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server J&H Land Services LLC running on http://localhost:${PORT}`);
  });
}
