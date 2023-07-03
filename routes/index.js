const express = require("express");
const router = express.Router();

router.get("/", function (req, res, next) {
  res.send("SERVER RUNNING")
});

router.get("/payment", async function (req, res, next) {
  const { id } = req.query
  if (id) {
    res.render("payment", { orderId: id });
  } else {
    res.render("payment-error");
  }
});

module.exports = router;
