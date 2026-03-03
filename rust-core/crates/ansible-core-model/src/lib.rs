use serde::{Deserialize, Serialize};

pub const SLA_SWEEP_CONTRACT_V1: &str = "schema://ansible/rust-core/sla-sweep/1.0.0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContractEnvelope {
    pub contract_schema_ref: String,
    pub case_id: String,
}
