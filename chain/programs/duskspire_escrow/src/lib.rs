// Duskspire arena stake escrow.
//
// Flow (docs/p2e/economy.md section 6): the game server creates a match escrow
// for two players at a stake tier; each player deposits their stake into the
// match vault (a token account owned by the match PDA); after the idle battle
// resolves server-side, the server authority settles the pot to the winner
// minus the rake, or refunds both players (draw, abort, no-show).
//
// Trust model: players never have to trust the server with custody of the pot
// (funds sit in a PDA vault the server cannot spend to itself: settle can only
// pay a depositor, and the rake can only go to the treasury account fixed at
// match creation). The server IS trusted to name the winner: match outcomes
// are server-authoritative in Duskspire by design, exactly like every other
// game outcome. 1v1 in v1; team formats aggregate at the game layer or extend
// this program with a player list in v2.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("DpJDnYmfYoW5Ciw475SyKzkFXjHwnN1YrBVaUiBdtDXH");

pub const MAX_RAKE_BPS: u16 = 2_000; // hard cap: a settle can never take more than 20 percent

#[program]
pub mod duskspire_escrow {
    use super::*;

    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: u64,
        stake: u64,
        rake_bps: u16,
    ) -> Result<()> {
        require!(stake > 0, EscrowError::ZeroStake);
        require!(rake_bps <= MAX_RAKE_BPS, EscrowError::RakeTooHigh);
        require!(
            ctx.accounts.player_a.key() != ctx.accounts.player_b.key(),
            EscrowError::DuplicatePlayer
        );
        let m = &mut ctx.accounts.match_state;
        m.authority = ctx.accounts.authority.key();
        m.treasury = ctx.accounts.treasury.key();
        m.mint = ctx.accounts.mint.key();
        m.match_id = match_id;
        m.stake = stake;
        m.rake_bps = rake_bps;
        m.player_a = ctx.accounts.player_a.key();
        m.player_b = ctx.accounts.player_b.key();
        m.deposited_a = false;
        m.deposited_b = false;
        m.state = MatchLifecycle::Open;
        m.bump = ctx.bumps.match_state;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, _match_id: u64) -> Result<()> {
        let m = &mut ctx.accounts.match_state;
        require!(m.state == MatchLifecycle::Open, EscrowError::WrongState);
        let payer = ctx.accounts.player.key();
        let slot = if payer == m.player_a {
            require!(!m.deposited_a, EscrowError::AlreadyDeposited);
            DepositSlot::A
        } else if payer == m.player_b {
            require!(!m.deposited_b, EscrowError::AlreadyDeposited);
            DepositSlot::B
        } else {
            return err!(EscrowError::NotAPlayer);
        };
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            m.stake,
        )?;
        match slot {
            DepositSlot::A => m.deposited_a = true,
            DepositSlot::B => m.deposited_b = true,
        }
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>, match_id: u64) -> Result<()> {
        let m = &ctx.accounts.match_state;
        require!(m.state == MatchLifecycle::Open, EscrowError::WrongState);
        require!(m.deposited_a && m.deposited_b, EscrowError::PotIncomplete);
        let winner = ctx.accounts.winner.key();
        require!(
            winner == m.player_a || winner == m.player_b,
            EscrowError::NotAPlayer
        );
        let pot = m
            .stake
            .checked_mul(2)
            .ok_or(EscrowError::MathOverflow)?;
        let rake = (pot as u128 * m.rake_bps as u128 / 10_000u128) as u64;
        let payout = pot.checked_sub(rake).ok_or(EscrowError::MathOverflow)?;

        let seeds: &[&[u8]] = &[b"match", &match_id.to_le_bytes(), &[m.bump]];
        let signer = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_token.to_account_info(),
                    authority: ctx.accounts.match_state.to_account_info(),
                },
                signer,
            ),
            payout,
        )?;
        if rake > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.treasury_token.to_account_info(),
                        authority: ctx.accounts.match_state.to_account_info(),
                    },
                    signer,
                ),
                rake,
            )?;
        }
        let m = &mut ctx.accounts.match_state;
        m.state = MatchLifecycle::Settled;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>, match_id: u64) -> Result<()> {
        let m = &ctx.accounts.match_state;
        require!(m.state == MatchLifecycle::Open, EscrowError::WrongState);
        let seeds: &[&[u8]] = &[b"match", &match_id.to_le_bytes(), &[m.bump]];
        let signer = &[seeds];
        if m.deposited_a {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.player_a_token.to_account_info(),
                        authority: ctx.accounts.match_state.to_account_info(),
                    },
                    signer,
                ),
                m.stake,
            )?;
        }
        if m.deposited_b {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.player_b_token.to_account_info(),
                        authority: ctx.accounts.match_state.to_account_info(),
                    },
                    signer,
                ),
                m.stake,
            )?;
        }
        let m = &mut ctx.accounts.match_state;
        m.state = MatchLifecycle::Refunded;
        Ok(())
    }
}

enum DepositSlot {
    A,
    B,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MatchLifecycle {
    Open,
    Settled,
    Refunded,
}

#[account]
pub struct MatchState {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub match_id: u64,
    pub stake: u64,
    pub rake_bps: u16,
    pub player_a: Pubkey,
    pub player_b: Pubkey,
    pub deposited_a: bool,
    pub deposited_b: bool,
    pub state: MatchLifecycle,
    pub bump: u8,
}

impl MatchState {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 2 + 32 + 32 + 1 + 1 + 1 + 1;
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    /// CHECK: the rake destination owner, fixed into the match at creation.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: player identity only, no data read.
    pub player_a: UncheckedAccount<'info>,
    /// CHECK: player identity only, no data read.
    pub player_b: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = MatchState::SIZE,
        seeds = [b"match", match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub match_state: Account<'info, MatchState>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = match_state
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"match", match_id.to_le_bytes().as_ref()],
        bump = match_state.bump
    )]
    pub match_state: Account<'info, MatchState>,
    #[account(
        mut,
        token::mint = match_state.mint,
        token::authority = player
    )]
    pub player_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = match_state.mint,
        associated_token::authority = match_state
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct Settle<'info> {
    #[account(address = match_state.authority @ EscrowError::WrongAuthority)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"match", match_id.to_le_bytes().as_ref()],
        bump = match_state.bump
    )]
    pub match_state: Account<'info, MatchState>,
    /// CHECK: validated against the stored players in the handler.
    pub winner: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = match_state.mint,
        token::authority = winner.key()
    )]
    pub winner_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = match_state.mint,
        token::authority = match_state.treasury
    )]
    pub treasury_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = match_state.mint,
        associated_token::authority = match_state
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct Refund<'info> {
    #[account(address = match_state.authority @ EscrowError::WrongAuthority)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"match", match_id.to_le_bytes().as_ref()],
        bump = match_state.bump
    )]
    pub match_state: Account<'info, MatchState>,
    #[account(
        mut,
        token::mint = match_state.mint,
        token::authority = match_state.player_a
    )]
    pub player_a_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = match_state.mint,
        token::authority = match_state.player_b
    )]
    pub player_b_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = match_state.mint,
        associated_token::authority = match_state
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum EscrowError {
    #[msg("stake must be positive")]
    ZeroStake,
    #[msg("rake exceeds the hard cap")]
    RakeTooHigh,
    #[msg("both players are the same account")]
    DuplicatePlayer,
    #[msg("match is not in the required state")]
    WrongState,
    #[msg("signer is not a player of this match")]
    NotAPlayer,
    #[msg("player already deposited")]
    AlreadyDeposited,
    #[msg("both stakes must be deposited before settle")]
    PotIncomplete,
    #[msg("only the match authority may do this")]
    WrongAuthority,
    #[msg("math overflow")]
    MathOverflow,
}
