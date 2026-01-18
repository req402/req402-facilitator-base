import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { supabase } from './supabase.js';

dotenv.config();

const PORT = process.env.PORT || "4022";

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const evmAccount = privateKeyToAccount(
  process.env.EVM_PRIVATE_KEY as `0x${string}`,
);
console.info(`EVM Facilitator account: ${evmAccount.address}`);

const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
  address: evmAccount.address,
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
    viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
});

const facilitator = new x402Facilitator()
  .onBeforeVerify(async (context) => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async (context) => {
    console.log("After verify", context);
  })
  .onVerifyFailure(async (context) => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async (context) => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async (context) => {
    console.log("After settle", context);
  })
  .onSettleFailure(async (context) => {
    console.log("Settle failure", context);
  });

registerExactEvmScheme(facilitator, {
  signer: evmSigner,
  networks: "eip155:84532", // Base Sepolia
  deployERC4337WithEIP6492: true,
});

const app = express();
app.use(express.json());

// Debug endpoint to check incoming payloads (optional, you can remove later)
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    // DEBUG: Log full incoming objects to see real field names
    console.log('=== DEBUG: paymentPayload ===', JSON.stringify(paymentPayload, null, 2));
    console.log('=== DEBUG: paymentRequirements ===', JSON.stringify(paymentRequirements, null, 2));

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    // ───────────────────────────────────────────────────────────────
    // Log transaction to Supabase after successful settlement
    // ───────────────────────────────────────────────────────────────
    try {
      // Adjust field names based on actual DEBUG logs you will see in Render
      const payerWallet = paymentPayload.payer || paymentPayload.sender || 'unknown';
      const amountStr = paymentRequirements.amount || paymentRequirements.value || '0';
      const amount = parseFloat(amountStr);
      const endpointPath = paymentRequirements.resource || paymentRequirements.path || '/unknown';
      const network = paymentPayload.network || 'base-sepolia';
      const txHash = response.transactionHash || response.hash || '0xmock';

      const { data: endpoint, error: findError } = await supabase
        .from('endpoints')
        .select('id, user_id')
        .eq('path', endpointPath)
        .eq('network', network)
        .maybeSingle();

      if (findError) {
        console.error('Error finding endpoint:', findError);
      } else if (endpoint) {
        const { error: insertError } = await supabase
          .from('transactions')
          .insert({
            user_id: endpoint.user_id,
            endpoint_id: endpoint.id,
            payer_wallet: payerWallet,
            amount,
            net_amount: amount, // subtract fee later if needed
            tx_hash: txHash,
            chain: network,
            status: 'success',
            created_at: new Date().toISOString()
          });

        if (insertError) {
          console.error('Error logging transaction to Supabase:', insertError);
        } else {
          console.log(`Transaction logged successfully for user_id: ${endpoint.user_id}`);
        }
      } else {
        console.warn(`Endpoint not found for path: ${endpointPath} and network: ${network}`);
      }
    } catch (logError) {
      console.error('Error during Supabase logging:', logError);
    }
    // ───────────────────────────────────────────────────────────────

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }
    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );
    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(parseInt(PORT), () => {
  console.log(`Facilitator listening on port ${PORT}`);
});
