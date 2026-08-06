use std::io;
use std::process;

fn main() {
    if let Err(err) = local_ci::bootstrap_from_process() {
        eprintln!("{err}");
        process::exit(1);
    }

    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    let exit_code = local_ci::run_cli(std::env::args().skip(1), &mut stdout, &mut stderr);
    process::exit(exit_code);
}
