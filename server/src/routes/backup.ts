import express, { Router } from "express";
import { exportBackup, importBackup, parseBackup, toCsv } from "../lib/backup.js";

export const backupRouter = Router();

/**
 * A restore body is one field holding a whole file. The app-wide limit is 2mb,
 * and a large library whose games carry notes goes past that, so this router
 * gets its own.
 */
backupRouter.use(express.json({ limit: "10mb" }));

backupRouter.get("/export", (req, res) => {
  const backup = exportBackup();
  const csv = req.query.format === "csv";
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="whatgamesnext-backup-${date}.${csv ? "csv" : "json"}"`,
  );
  if (csv) {
    res.type("text/csv").send(toCsv(backup));
  } else {
    res.type("application/json").send(JSON.stringify(backup, null, 2));
  }
});

backupRouter.post("/import", (req, res) => {
  const text = (req.body as { text?: string }).text;
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "body must be { text: string } — a backup file" });
  }
  try {
    res.json(importBackup(parseBackup(text)));
  } catch (err) {
    // Parse failures name the game and the field, so they're worth showing.
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
