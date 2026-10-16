-- Cash vouchers booked in ONE entry when finance pays (owner, 2026-10-16: "It
-- should pass only one entry when booked by finance, either docs are attached
-- or not, if docs are attached with voucher after transaction is booked by
-- Finance, it should only save the doc and attached it below the system
-- generated voucher").
-- bookedAtPay true = the pay booked the expense (Dr the voucher's account /
-- Cr the box 1011 | 1010 | the bank); documents and finance's check post
-- nothing, and nothing sits on 1357. Every existing row keeps its rules
-- (false): a voucher already held on 1357 still clears it at verification.
ALTER TABLE "cash_vouchers"
  ADD COLUMN "bookedAtPay" BOOLEAN NOT NULL DEFAULT false;
