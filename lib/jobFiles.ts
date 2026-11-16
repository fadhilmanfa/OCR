// Pembuatan arsip hasil (ZIP + PDF) dari file PNG di folder job.
// Dipakai setelah proses awal DAN setelah render ulang mask manual.
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import PDFDocument from "pdfkit";
import sharp from "sharp";

export async function buildJobArchives(jobDir: string, files: string[]): Promise<void> {
  const zip = new AdmZip();
  for (const file of files) zip.addLocalFile(path.join(jobDir, file));
  zip.writeZip(path.join(jobDir, "hasil.zip"));

  const pdfPath = path.join(jobDir, "hasil.pdf");
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    (async () => {
      for (const file of files) {
        const buf = fs.readFileSync(path.join(jobDir, file));
        const meta = await sharp(buf).metadata();
        doc.addPage({ size: [meta.width || 800, meta.height || 1200] });
        doc.image(buf, 0, 0, { width: meta.width, height: meta.height });
      }
      doc.end();
    })().catch(reject);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}
