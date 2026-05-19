const express = require("express");
const crypto = require("crypto");
const app = express();

app.use(express.json());

// Your eBay verification token - keep this secret!
// You'll set this same string in your eBay developer dashboard
const VERIFICATION_TOKEN = process.env.VERIFICATION_TOKEN || "listsync_verification_token_change_me";
const ENDPOINT_URL = process.env.ENDPOINT_URL || "https://your-app.onrender.com/ebay/account-deletion";

// eBay Account Deletion Notification Endpoint
// eBay will send GET requests to verify your endpoint
app.get("/ebay/account-deletion", (req, res) => {
  const challengeCode = req.query.challenge_code;

  if (!challengeCode) {
    return res.status(400).json({ error: "Missing challenge_code" });
  }

  // eBay requires this specific hash to verify your endpoint
  const hash = crypto.createHash("sha256");
  hash.update(challengeCode);
  hash.update(VERIFICATION_TOKEN);
  hash.update(ENDPOINT_URL);
  const challengeResponse = hash.digest("hex");

  console.log(`eBay verification challenge received, responding with hash`);

  return res.status(200).json({ challengeResponse });
});

// eBay will send POST requests when a user deletes their account
app.post("/ebay/account-deletion", (req, res) => {
  const notification = req.body;
  console.log("eBay account deletion notification received:", JSON.stringify(notification, null, 2));

  // In a real app you would delete any stored user data here.
  // Since this is a personal app, we just acknowledge receipt.

  return res.status(200).json({ message: "Notification received" });
});

// Health check
app.get("/", (req, res) => {
  res.status(200).json({ status: "ListSync compliance server running ✅" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ListSync compliance server running on port ${PORT}`);
});
