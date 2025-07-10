pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("F23xR3HKP9LycZcV5CdbAoHSFGm1btYP5npArW1Cky3E");

#[program]
pub mod escrow {
    use super::*;

    pub fn make(
        ctx: Context<Make>,
        seed: u64,
        deposit_amount: u64,
        receive: u64,) 
        -> Result<()> {

        ctx.accounts.init_escrow_and_deposit(seed, deposit_amount, receive,&ctx.bumps)
        
    }

    pub fn refund(ctx: Context<Refund>)->Result<()>{
        ctx.accounts.refund_and_close_vault()
        
    }

    pub fn transfer(ctx: Context<Transfer>)->Result<()>{
        ctx.accounts.transfer_and_close_vault()   
    }
}
