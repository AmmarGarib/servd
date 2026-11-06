// PDF bank statements (owner, 2026-11-06: "Add pdf format option also for bank statement import").
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { pdfStatementCsv } from '../src/modules/reconciliation/pdfStatement.js'
import { parseStatementCsv } from '../src/modules/reconciliation/service.js'

async function statementPdf(pages: Array<Array<[number, number, string]>>): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const words of pages) {
    const page = doc.addPage([842, 595])
    for (const [x, y, t] of words) page.drawText(t, { x, y, size: 9, font })
  }
  return Buffer.from(await doc.save())
}

const HEADER: Array<[number, number, string]> = [
  [40, 500, 'Txn Date'], [110, 500, 'Value Date'], [180, 500, 'Narration'], [420, 500, 'Cheque No.'],
  [500, 500, 'Debit'], [590, 500, 'Credit'], [690, 500, 'Balance'],
]

describe('PDF bank statement', () => {
  it('reads debit / credit columns, wrapped narrations, continuation pages and skips footers', async () => {
    const buf = await statementPdf([
      [
        [40, 560, 'Meezan Bank — Account statement'], [40, 545, 'Period 01-Nov-2026 to 30-Nov-2026'],
        ...HEADER,
        [40, 480, '01-Nov-2026'], [110, 480, '01-Nov-2026'], [180, 480, 'Balance brought forward'], [690, 480, '100,000.00'],
        [40, 465, '02-Nov-2026'], [110, 465, '02-Nov-2026'], [180, 465, 'CHQ PAID ASIF ALI'], [420, 465, '10045'], [500, 465, '3,880.00'], [690, 465, '96,120.00'],
        [180, 452, 'FOR CAKE ORDERS'],
        [40, 437, '03/11/2026'], [110, 437, '03/11/2026'], [180, 437, 'CASH DEPOSIT'], [590, 437, '25,000.50'], [690, 437, '121,120.50'],
        [40, 60, 'Page 1 of 2'],
      ],
      [
        [40, 560, '04 Nov 2026'], [110, 560, '04 Nov 2026'], [180, 560, 'IBFT FROM FLIPD'], [590, 560, '1,000.00'], [690, 560, '122,120.50'],
        [180, 520, 'Total'], [500, 520, '3,880.00'], [590, 520, '26,000.50'],
      ],
    ])
    const csv = await pdfStatementCsv(buf)
    const lines = parseStatementCsv(csv)
    expect(lines.map((l) => [l.postedDate.toISOString().slice(0, 10), l.amountCents, l.reference])).toEqual([
      ['2026-11-02', -388000, '10045'],
      ['2026-11-03', 2500050, null],
      ['2026-11-04', 100000, null],
    ])
    expect(lines[0]!.description).toBe('CHQ PAID ASIF ALI FOR CAKE ORDERS')
  })

  it('reads a single signed amount column with DR / CR', async () => {
    const buf = await statementPdf([[
      [40, 500, 'Date'], [150, 500, 'Description'], [450, 500, 'Amount'], [600, 500, 'Balance'],
      [40, 480, '2026-11-05'], [150, 480, 'BANK CHARGES'], [450, 480, '150.00 DR'], [600, 480, '9,850.00'],
      [40, 465, '2026-11-06'], [150, 465, 'RAAST IN'], [450, 465, '2,000.00 CR'], [600, 465, '11,850.00'],
    ]])
    const lines = parseStatementCsv(await pdfStatementCsv(buf))
    expect(lines.map((l) => l.amountCents)).toEqual([-15000, 200000])
  })

  it('refuses a PDF with no text and a file that is not a PDF', async () => {
    const empty = Buffer.from(await (await PDFDocument.create()).addPage().doc.save())
    await expect(pdfStatementCsv(empty)).rejects.toMatchObject({ code: 'BAD_PDF_STATEMENT' })
    await expect(pdfStatementCsv(Buffer.from('date,amount\n'))).rejects.toMatchObject({ code: 'BAD_PDF_STATEMENT' })
  })
})
