export const PathwayAttributes = {
    ENTRY: 'cgx.pathway.entry',
    ROOT: 'cgx.pathway.root',
    ROOT_SERVICE: 'cgx.pathway.root.service',
    ROOT_TRANSACTION: 'cgx.pathway.root.transaction',
    CALLER: 'cgx.pathway.caller',
    ID: 'cgx.pathway.id',
    PARENT_ID: 'cgx.pathway.parent_id',
    DEPTH: 'cgx.pathway.depth',
};

export const PathwayMetricAttributes = {
    ROOT_SERVICE: 'cgx_pathway_root_service',
    ROOT_TRANSACTION: 'cgx_pathway_root_transaction',
    CALLER: 'cgx_pathway_caller',
    SERVICE: 'service_name',
    DESTINATION: 'cgx_pathway_destination',
    DESTINATION_TYPE: 'cgx_pathway_destination_type',
    ID: 'cgx_pathway_id',
    PARENT_ID: 'cgx_pathway_parent_id',
    DEPTH: 'cgx_pathway_depth',
    ERROR: 'error',
};

export const PathwayTraceState = {
    ROOT_SERVICE: 'cgx_pw_root',
    ROOT_TRANSACTION: 'cgx_pw_tx',
    CALLER: 'cgx_pw_caller',
    ID: 'cgx_pw_id',
    DEPTH: 'cgx_pw_depth',
};

export const PathwayMetrics = {
    HOP_DURATION: 'cgx.pathway.hop.duration',
    OUTBOUND_DURATION: 'cgx.pathway.outbound.duration',
    DURATION: 'cgx.pathway.duration',
    INFO: 'cgx.pathway.info',
};

export const UNKNOWN_CALLER = 'unknown';
export const OVERFLOW_PATHWAY_ID = 'overflow';
