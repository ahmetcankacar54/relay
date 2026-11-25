// The parity recordings' clock (rust/README.md): with RELAY_PARITY_NOW set to an ISO instant, this
// process's wall clock starts at that instant and runs on from there, so dates, ages and today's
// quarter hours come out the same on every run. Loaded with `node --import` before relay's own
// code; the Rust build reads the same variable (cargo feature `parity`).
const start = Date.parse(process.env.RELAY_PARITY_NOW ?? "");
if (Number.isFinite(start)) {
  const RealDate = Date;
  const offset = start - RealDate.now();
  class ParityDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + offset);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ParityDate;
}
