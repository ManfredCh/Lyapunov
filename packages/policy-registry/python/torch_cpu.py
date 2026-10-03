"""固定来源 TorchScript/ONNX CPU 推理；物理步进始终由 ctx.sim 持有。"""
import json
import sys
policy = None
adaptation = None
format = 'torchscript'
for line in sys.stdin:
    request = json.loads(line)
    try:
        if request['method'] == 'load':
            format = request.get('format', 'torchscript')
            if format == 'onnx':
                import onnxruntime as ort
                import numpy as np
                options = ort.SessionOptions()
                options.intra_op_num_threads = 1
                options.inter_op_num_threads = 1
                policy = ort.InferenceSession(request['weightsPath'], sess_options=options, providers=['CPUExecutionProvider'])
                result = {'device':'cpu','onnxruntimeVersion':ort.__version__,'inputs':[x.shape for x in policy.get_inputs()],'outputs':[x.shape for x in policy.get_outputs()]}
            elif format == 'torchscript-adaptation':
                # 两级形态（仅 WTW 这类 history-conditioned 策略）：body 吃 (历史 ‖ latent)。
                # 实测契约：adaptation(1,2100)->(1,2)、body(1,2102)->(1,12)。
                import torch
                torch.set_num_threads(1)
                policy = torch.jit.load(request['weightsPath'], map_location='cpu').eval()
                adaptation = torch.jit.load(request['adaptationPath'], map_location='cpu').eval()
                result = {'device':'cpu','torchVersion':torch.__version__,'format':format,
                          'parameters':sum(p.numel() for p in policy.parameters()),
                          'adaptationParameters':sum(p.numel() for p in adaptation.parameters())}
            else:
                import torch
                torch.set_num_threads(1)
                policy = torch.jit.load(request['weightsPath'], map_location='cpu').eval()
                result = {'device':'cpu','torchVersion':torch.__version__,'parameters':sum(p.numel() for p in policy.parameters())}
        else:
            if format == 'onnx':
                result = policy.run(None, {policy.get_inputs()[0].name: np.asarray([request['observation']],dtype=np.float32)})[0].reshape(-1).tolist()
            elif format == 'torchscript-adaptation':
                history = torch.tensor([request['observation']], dtype=torch.float32, device='cpu')
                with torch.inference_mode():
                    latent = adaptation(history)
                    result = policy(torch.cat((history, latent), dim=-1)).detach().cpu().reshape(-1).tolist()
            else:
                obs = torch.tensor([request['observation']], dtype=torch.float32, device='cpu')
                with torch.inference_mode():
                    result = policy(obs).detach().cpu().reshape(-1).tolist()
            if len(result) != request['actions'] or not all(__import__('math').isfinite(x) for x in result):
                raise ValueError('POLICY_ACTION_INVALID')
        print(json.dumps({'id':request['id'],'result':result},allow_nan=False),flush=True)
    except Exception as exc:
        print(json.dumps({'id':request['id'],'error':str(exc)}),flush=True)
