import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import { 
  PublicKey, 
  Keypair, 
  SystemProgram, 
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddress
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("Escrow Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;
  
  // Test accounts
  let payer: Keypair;
  let maker: Keypair;
  let taker: Keypair;
  let mintA: PublicKey;
  let mintB: PublicKey;
  let makerAtaA: PublicKey;
  let makerAtaB: PublicKey;
  let takerAtaA: PublicKey;
  let takerAtaB: PublicKey;
  let escrowPda: PublicKey;
  let escrowVault: PublicKey;
  let escrowBump: number;

  const seed = new anchor.BN(123456789);
  const depositAmount = 1000000; // 1 token (assuming 6 decimals)
  const receiveAmount = 2000000; // 2 tokens

  before(async () => {
    // Initialize keypairs
    payer = Keypair.generate();
    maker = Keypair.generate();
    taker = Keypair.generate();

    // Airdrop SOL to test accounts
    await provider.connection.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(maker.publicKey, 10 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(taker.publicKey, 10 * LAMPORTS_PER_SOL);

    // Wait for airdrops to confirm
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Create mints
    mintA = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    mintB = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    // Create associated token accounts
    makerAtaA = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mintA,
      maker.publicKey
    );

    makerAtaB = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mintB,
      maker.publicKey
    );

    takerAtaA = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mintA,
      taker.publicKey
    );

    takerAtaB = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      mintB,
      taker.publicKey
    );

    // Mint tokens to accounts
    await mintTo(
      provider.connection,
      payer,
      mintA,
      makerAtaA,
      payer.publicKey,
      depositAmount * 3 // Give enough for multiple tests
    );

    await mintTo(
      provider.connection,
      payer,
      mintB,
      takerAtaB,
      payer.publicKey,
      receiveAmount * 3 // Give enough for multiple tests
    );

    // Derive escrow PDA
    [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        maker.publicKey.toBuffer(),
        seed.toArrayLike(Buffer, "le", 8)
      ],
      program.programId
    );

    // Derive escrow vault (ATA for escrow PDA)
    escrowVault = await getAssociatedTokenAddress(
      mintA,
      escrowPda,
      true // Allow owner off curve
    );
  });

  describe("Make Escrow", () => {
    it("Should initialize escrow and deposit tokens successfully", async () => {
      const initialMakerBalance = await getAccount(provider.connection, makerAtaA);

      await program.methods
        .make(seed, new anchor.BN(depositAmount), new anchor.BN(receiveAmount))
        .accounts({
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaA: makerAtaA,
          escrow: escrowPda,
          escrowVault: escrowVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();

      // Verify escrow account state
      const escrowData = await program.account.escrow.fetch(escrowPda);
      assert.equal(escrowData.seed.toString(), seed.toString());
      assert.equal(escrowData.maker.toString(), maker.publicKey.toString());
      assert.equal(escrowData.mintA.toString(), mintA.toString());
      assert.equal(escrowData.mintB.toString(), mintB.toString());
      assert.equal(escrowData.receive.toString(), receiveAmount.toString());
      assert.equal(escrowData.bump, escrowBump);

      // Verify tokens were transferred to vault
      const vaultAccount = await getAccount(provider.connection, escrowVault);
      assert.equal(vaultAccount.amount.toString(), depositAmount.toString());

      // Verify maker's token account was debited
      const finalMakerBalance = await getAccount(provider.connection, makerAtaA);
      assert.equal(
        finalMakerBalance.amount.toString(),
        (Number(initialMakerBalance.amount) - depositAmount).toString()
      );
    });

    it("Should fail to initialize escrow with insufficient funds", async () => {
      const newSeed = new anchor.BN(987654321);
      const [newEscrowPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          newSeed.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      const newEscrowVault = await getAssociatedTokenAddress(
        mintA,
        newEscrowPda,
        true
      );

      try {
        await program.methods
          .make(newSeed, new anchor.BN(depositAmount * 10), new anchor.BN(receiveAmount))
          .accounts({
            maker: maker.publicKey,
            mintA: mintA,
            mintB: mintB,
            makerAtaA: makerAtaA,
            escrow: newEscrowPda,
            escrowVault: newEscrowVault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([maker])
          .rpc();
        
        assert.fail("Should have failed with insufficient funds");
      } catch (error) {
        assert.include(error.message, "insufficient funds");
      }
    });

    it("Should fail to initialize escrow with zero amounts", async () => {
      const zeroSeed = new anchor.BN(111111111);
      const [zeroEscrowPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          zeroSeed.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      const zeroEscrowVault = await getAssociatedTokenAddress(
        mintA,
        zeroEscrowPda,
        true
      );

      try {
        await program.methods
          .make(zeroSeed, new anchor.BN(0), new anchor.BN(receiveAmount))
          .accounts({
            maker: maker.publicKey,
            mintA: mintA,
            mintB: mintB,
            makerAtaA: makerAtaA,
            escrow: zeroEscrowPda,
            escrowVault: zeroEscrowVault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([maker])
          .rpc();
        
        assert.fail("Should have failed with zero deposit amount");
      } catch (error) {
        // Error will depend on your program's validation logic
        assert.isTrue(error.message.includes("Error") || error.message.includes("invalid"));
      }
    });
  });

  describe("Transfer (Exchange) Escrow", () => {
    let transferEscrowPda: PublicKey;
    let transferEscrowVault: PublicKey;
    let transferSeed: anchor.BN;

    beforeEach(async () => {
      // Create a new escrow for each transfer test
      transferSeed = new anchor.BN(Math.floor(Math.random() * 1000000));
      [transferEscrowPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          transferSeed.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      transferEscrowVault = await getAssociatedTokenAddress(
        mintA,
        transferEscrowPda,
        true
      );

      // Initialize escrow
      await program.methods
        .make(transferSeed, new anchor.BN(depositAmount), new anchor.BN(receiveAmount))
        .accounts({
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaA: makerAtaA,
          escrow: transferEscrowPda,
          escrowVault: transferEscrowVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();
    });

    it("Should complete transfer successfully", async () => {
      // Get initial balances
      const initialMakerB = await getAccount(provider.connection, makerAtaB);
      const initialTakerA = await getAccount(provider.connection, takerAtaA);
      const initialTakerB = await getAccount(provider.connection, takerAtaB);

      await program.methods
        .transfer(transferSeed)
        .accounts({
          maker: maker.publicKey,
          taker: taker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaB: makerAtaB,
          takerAtaA: takerAtaA,
          takerAtaB: takerAtaB,
          escrow: transferEscrowPda,
          vault: transferEscrowVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([taker])
        .rpc();

      // Verify final balances
      const finalMakerB = await getAccount(provider.connection, makerAtaB);
      const finalTakerA = await getAccount(provider.connection, takerAtaA);
      const finalTakerB = await getAccount(provider.connection, takerAtaB);

      // Maker should receive taker's tokens
      assert.equal(
        finalMakerB.amount.toString(),
        (Number(initialMakerB.amount) + receiveAmount).toString()
      );

      // Taker should receive maker's tokens from escrow
      assert.equal(
        finalTakerA.amount.toString(),
        (Number(initialTakerA.amount) + depositAmount).toString()
      );

      // Taker should have sent tokens to maker
      assert.equal(
        finalTakerB.amount.toString(),
        (Number(initialTakerB.amount) - receiveAmount).toString()
      );

      // Escrow account should be closed
      try {
        await program.account.escrow.fetch(transferEscrowPda);
        assert.fail("Escrow account should be closed");
      } catch (error) {
        assert.include(error.message, "Account does not exist");
      }
    });

    it("Should fail transfer with insufficient taker funds", async () => {
      // Create escrow that requires more than taker has
      const highDemandSeed = new anchor.BN(Math.floor(Math.random() * 1000000));
      const [highDemandEscrowPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          highDemandSeed.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      const highDemandVault = await getAssociatedTokenAddress(
        mintA,
        highDemandEscrowPda,
        true
      );

      // Initialize escrow with high receive amount
      await program.methods
        .make(highDemandSeed, new anchor.BN(depositAmount), new anchor.BN(receiveAmount * 10))
        .accounts({
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaA: makerAtaA,
          escrow: highDemandEscrowPda,
          escrowVault: highDemandVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();

      // Try to transfer with insufficient funds
      try {
        await program.methods
          .transfer(highDemandSeed)
          .accounts({
            maker: maker.publicKey,
            taker: taker.publicKey,
            mintA: mintA,
            mintB: mintB,
            makerAtaB: makerAtaB,
            takerAtaA: takerAtaA,
            takerAtaB: takerAtaB,
            escrow: highDemandEscrowPda,
            vault: highDemandVault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([taker])
          .rpc();
        
        assert.fail("Should have failed with insufficient funds");
      } catch (error) {
        assert.include(error.message, "insufficient funds");
      }
    });

    it("Should fail transfer with wrong maker account", async () => {
      const wrongMaker = Keypair.generate();

      try {
        await program.methods
          .transfer(transferSeed)
          .accounts({
            maker: wrongMaker.publicKey, // Wrong maker
            taker: taker.publicKey,
            mintA: mintA,
            mintB: mintB,
            makerAtaB: makerAtaB,
            takerAtaA: takerAtaA,
            takerAtaB: takerAtaB,
            escrow: transferEscrowPda,
            vault: transferEscrowVault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([taker])
          .rpc();
        
        assert.fail("Should have failed with wrong maker");
      } catch (error) {
        assert.include(error.message, "A has_one constraint was violated");
      }
    });
  });

  describe("Refund Escrow", () => {
    let refundEscrowPda: PublicKey;
    let refundEscrowVault: PublicKey;
    let refundSeed: anchor.BN;

    beforeEach(async () => {
      // Create a new escrow for refund test
      refundSeed = new anchor.BN(Math.floor(Math.random() * 1000000));
      [refundEscrowPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          refundSeed.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      refundEscrowVault = await getAssociatedTokenAddress(
        mintA,
        refundEscrowPda,
        true
      );

      // Initialize escrow
      await program.methods
        .make(refundSeed, new anchor.BN(depositAmount), new anchor.BN(receiveAmount))
        .accounts({
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaA: makerAtaA,
          escrow: refundEscrowPda,
          escrowVault: refundEscrowVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();
    });

    it("Should refund escrow successfully", async () => {
      const initialMakerBalance = await getAccount(provider.connection, makerAtaA);

      await program.methods
        .refund(refundSeed)
        .accounts({
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaA: makerAtaA,
          escrow: refundEscrowPda,
          vault: refundEscrowVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();

      // Verify tokens were returned to maker
      const finalMakerBalance = await getAccount(provider.connection, makerAtaA);
      assert.equal(
        finalMakerBalance.amount.toString(),
        (Number(initialMakerBalance.amount) + depositAmount).toString()
      );

      // Escrow account should be closed
      try {
        await program.account.escrow.fetch(refundEscrowPda);
        assert.fail("Escrow account should be closed");
      } catch (error) {
        assert.include(error.message, "Account does not exist");
      }
    });

    it("Should fail to refund escrow by non-maker", async () => {
      try {
        await program.methods
          .refund(refundSeed)
          .accounts({
            maker: taker.publicKey, // Wrong signer
            mintA: mintA,
            mintB: mintB,
            makerAtaA: makerAtaA,
            escrow: refundEscrowPda,
            vault: refundEscrowVault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([taker])
          .rpc();
        
        assert.fail("Should have failed with wrong signer");
      } catch (error) {
        assert.include(error.message, "A has_one constraint was violated");
      }
    });

    it("Should fail to refund with wrong seed", async () => {
      const wrongSeed = new anchor.BN(999999999);

      try {
        await program.methods
          .refund(wrongSeed)
          .accounts({
            maker: maker.publicKey,
            mintA: mintA,
            mintB: mintB,
            makerAtaA: makerAtaA,
            escrow: refundEscrowPda, // This won't match the wrong seed
            vault: refundEscrowVault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([maker])
          .rpc();
        
        assert.fail("Should have failed with wrong seed");
      } catch (error) {
        assert.include(error.message, "seeds constraint was violated");
      }
    });
  });

  describe("Edge Cases and Security", () => {
    it("Should handle same mint for both tokens", async () => {
      const sameMintSeed = new anchor.BN(Math.floor(Math.random() * 1000000));
      const [sameMintEscrowPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          sameMintSeed.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      const sameMintVault = await getAssociatedTokenAddress(
        mintA,
        sameMintEscrowPda,
        true
      );

      await program.methods
        .make(sameMintSeed, new anchor.BN(depositAmount), new anchor.BN(receiveAmount))
        .accounts({
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintA, // Same mint
          makerAtaA: makerAtaA,
          escrow: sameMintEscrowPda,
          escrowVault: sameMintVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();

      // Verify escrow was created successfully
      const escrowData = await program.account.escrow.fetch(sameMintEscrowPda);
      assert.equal(escrowData.mintA.toString(), mintA.toString());
      assert.equal(escrowData.mintB.toString(), mintA.toString());
    });

    it("Should prevent PDA collision with different seeds", async () => {
      const seed1 = new anchor.BN(111111);
      const seed2 = new anchor.BN(222222);
      
      const [escrow1] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          seed1.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      const [escrow2] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          seed2.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      // Different seeds should produce different PDAs
      assert.notEqual(escrow1.toString(), escrow2.toString());
    });

    it("Should handle multiple escrows for same maker", async () => {
      const seed1 = new anchor.BN(Math.floor(Math.random() * 1000000));
      const seed2 = new anchor.BN(Math.floor(Math.random() * 1000000));
      
      const [escrow1] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          seed1.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      const [escrow2] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          maker.publicKey.toBuffer(),
          seed2.toArrayLike(Buffer, "le", 8)
        ],
        program.programId
      );

      const vault1 = await getAssociatedTokenAddress(mintA, escrow1, true);
      const vault2 = await getAssociatedTokenAddress(mintA, escrow2, true);

      // Create first escrow
      await program.methods
        .make(seed1, new anchor.BN(depositAmount), new anchor.BN(receiveAmount))
        .accounts({
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaA: makerAtaA,
          escrow: escrow1,
          escrowVault: vault1,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();

      // Create second escrow
      await program.methods
        .make(seed2, new anchor.BN(depositAmount), new anchor.BN(receiveAmount))
        .accounts({
          maker: maker.publicKey,
          mintA: mintA,
          mintB: mintB,
          makerAtaA: makerAtaA,
          escrow: escrow2,
          escrowVault: vault2,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();

      // Both escrows should exist
      const escrowData1 = await program.account.escrow.fetch(escrow1);
      const escrowData2 = await program.account.escrow.fetch(escrow2);
      
      assert.equal(escrowData1.seed.toString(), seed1.toString());
      assert.equal(escrowData2.seed.toString(), seed2.toString());
    });
  });
});