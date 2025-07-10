#![allow(unexpected_cfgs)]

use std::mem::take;

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, 
    token_interface::{CloseAccount,TokenAccount, Mint, TokenInterface, transfer_checked, TransferChecked, close_account}
};

use crate::Escrow;

/*
    accounts required:
        - maker
        - taker
        - mint_a
        - mint_b
        - maker_ata_b
        - taker_ata_a
        - taker_ata_b
        - escrow
        - vault
        - other three accounts
*/

#[derive(Accounts)]
#[instruction(seed:u64)]
pub struct Transfer<'info>{

    #[account(mut)]
    pub maker: SystemAccount<'info>,

    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(
        mint::token_program = token_program,
    )]
    pub mint_a: InterfaceAccount<'info, Mint>,

    #[account(
        mint::token_program = token_program,
    )]
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::token_program = token_program,
        associated_token::authority = maker,
    )]
    pub maker_ata_b: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::token_program = token_program,
        associated_token::authority = taker,
    )]
    pub taker_ata_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::token_program = token_program,
        associated_token::authority = taker,
    )]
    pub taker_ata_b: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        close = maker,
        has_one = maker,
        has_one = mint_a,
        has_one = mint_b,
        seeds = [b"escrow", maker.key().as_ref(), seed.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    // Token account owned by the escrow PDA
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info>Transfer<'info>{

    pub fn transfer_and_close_vault(&mut self) -> Result<()>{

        /* Step:1 first we will transfer the tokens from taker_ata_b to maker_ata_b */
        let taker_cpi_accounts = TransferChecked{
            from: self.taker_ata_b.to_account_info(),
            mint: self.mint_b.to_account_info(),
            to: self.maker_ata_b.to_account_info(),
            authority: self.taker.to_account_info()
        };

        let taker_cpi_ctx = CpiContext::new(self.token_program.to_account_info(), taker_cpi_accounts);

        transfer_checked(taker_cpi_ctx, self.escrow.receive, self.mint_b.decimals)?;
        
        /* 
            Step:2 
            - now we will transfer tokens from vault to taker_ata_b 
            - these bindings are essential, else we will see type errors
        */
        let binding_one = self.maker.to_account_info().key();
        let binding_two = self.escrow.seed.to_le_bytes();
       
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            binding_one.as_ref(),
            binding_two.as_ref(),
            &[self.escrow.bump]
        ]];

        let vault_cpi_accounts = TransferChecked{
            from: self.vault.to_account_info(),
            mint: self.mint_a.to_account_info(),
            to: self.taker_ata_a.to_account_info(),
            authority: self.escrow.to_account_info()
        };

        let vault_cpi_ctx = CpiContext::new_with_signer(self.token_program.to_account_info(), vault_cpi_accounts, signer_seeds);

        // the transfer will be all the amount stored in the vault
        transfer_checked(vault_cpi_ctx,self.vault.amount, self.mint_a.decimals)?;

        /* 
            Step:3
            - now we will transfer tokens from vault to taker_ata_b 
            - these bindings are essential, else we will see type errors
        */

        let close_accounts = CloseAccount {
            account: self.vault.to_account_info(),
            destination: self.maker.to_account_info(),
            authority: self.escrow.to_account_info(),
        };

        let close_cpi_ctx = CpiContext::new_with_signer(self.token_program.to_account_info(), close_accounts, &signer_seeds);

        close_account(close_cpi_ctx)?;

        Ok(())
    }
}