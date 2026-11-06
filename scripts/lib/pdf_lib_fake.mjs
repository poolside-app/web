// A stand-in for pdf-lib in offline tests: records what a PDF would show
// (each drawText string and each drawn image) instead of building a file.
export const drawn = { texts: [], images: 0 };
export function resetDrawn() { drawn.texts = []; drawn.images = 0; }
export const StandardFonts = { Helvetica: 'Helvetica', HelveticaBold: 'Helvetica-Bold' };
export const rgb = (r, g, b) => ({ r, g, b });
const font = { widthOfTextAtSize: (s, size) => String(s).length * size * 0.5, heightAtSize: size => size };
function page() {
  return {
    drawText: s => { drawn.texts.push(String(s)); },
    drawImage: () => { drawn.images++; },
    drawLine: () => {}, drawRectangle: () => {},
    getSize: () => ({ width: 612, height: 792 }),
  };
}
export const PDFDocument = {
  create: async () => ({
    embedFont: async () => font,
    embedPng: async () => ({ width: 300, height: 100 }),
    embedJpg: async () => ({ width: 400, height: 400 }),
    addPage: () => page(),
    setTitle: () => {}, setAuthor: () => {}, setSubject: () => {}, setCreator: () => {}, setProducer: () => {}, setCreationDate: () => {},
    save: async () => new Uint8Array([37, 80, 68, 70]),
  }),
};
