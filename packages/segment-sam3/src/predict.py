"""SAM3 图像/文本/框选真实推理。只使用明确本地 checkpoint，不在运行时下载。"""
from __future__ import annotations
import os,sys,json,time,math
from pathlib import Path
os.environ['HF_ENDPOINT']='https://hf-mirror.com'
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_XET']='1'

class ProviderUnavailable(RuntimeError):pass

def predict(request):
    checkpoint=Path(os.environ.get('LYAPUNOV_SAM3_CHECKPOINT','/missing-sam3-checkpoint')).expanduser().resolve()
    if not checkpoint.is_file():raise ProviderUnavailable('facebook/sam3/sam3.pt 本地 checkpoint 不存在；需镜像可访问及正式模型访问授权')
    if not request.get('textPrompt') and not request.get('boxPrompts'):raise ValueError('至少提供 textPrompt 或 boxPrompts')
    source=request['source']
    if not source.get('sceneId') or not source.get('frameId') or not isinstance(source.get('sceneRevision'),int):raise ValueError('来源必须含 sceneId、sceneRevision 和 frameId')
    if source.get('worldId') and not isinstance(source.get('worldGeneration'),int):raise ValueError('worldId 必须对应明确 worldGeneration')
    image_path=Path(request['imagePath']).expanduser().resolve()
    output=Path(request['outputDirectory']).expanduser().resolve()
    import torch
    from PIL import Image,ImageDraw
    import numpy as np
    from sam3.model_builder import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor
    device=os.environ.get('LYAPUNOV_SAM3_DEVICE','cuda')
    if device.startswith('cuda') and not torch.cuda.is_available():raise ProviderUnavailable('SAM3 CUDA 运行资源不可用')
    threshold=request.get('confidenceThreshold',.5)
    if not isinstance(threshold,(int,float)) or not 0<=threshold<=1:raise ValueError('confidenceThreshold 必须在 [0,1]')
    image=Image.open(image_path).convert('RGB');w,h=image.size
    normalized_boxes=[]
    for prompt in request.get('boxPrompts',[]):
      box=prompt['boxXYXY']
      if len(box)!=4 or not all(math.isfinite(x) for x in box):raise ValueError('boxXYXY 必须为有限的像素坐标')
      x0,y0,x1,y1=box
      if not (0<=x0<x1<=w and 0<=y0<y1<=h):raise ValueError('boxXYXY 超出原图边界或宽高非正')
      normalized_boxes.append(([(x0+x1)/(2*w),(y0+y1)/(2*h),(x1-x0)/w,(y1-y0)/h],bool(prompt['positive'])))
    started=time.perf_counter()
    model=build_sam3_image_model(checkpoint_path=str(checkpoint),load_from_HF=False,device=device,eval_mode=True,enable_segmentation=True,enable_inst_interactivity=False,compile=False)
    processor=Sam3Processor(model,device=device,confidence_threshold=threshold)
    with torch.inference_mode(),torch.autocast(device_type='cuda',dtype=torch.bfloat16,enabled=device.startswith('cuda')):
      state=processor.set_image(image)
      if request.get('textPrompt'):state=processor.set_text_prompt(prompt=request['textPrompt'],state=state)
      for box,label in normalized_boxes:state=processor.add_geometric_prompt(box=box,label=label,state=state)
    if device.startswith('cuda'):torch.cuda.synchronize()
    elapsed=time.perf_counter()-started
    # SAM3 CUDA inference returns bfloat16 tensors; convert at the provider
    # boundary before NumPy/PIL serialization so CPU and GPU paths share the
    # same JSON/PNG contract.
    masks=state['masks'].detach().float().cpu().numpy();boxes=state['boxes'].detach().float().cpu().numpy();scores=state['scores'].detach().float().cpu().numpy()
    output.mkdir(parents=True,exist_ok=True)
    # 图像副本和分割均在本次 Provider 私有产物目录，用户原图保留。
    image.save(output/'source.png');overlay=np.asarray(image).copy().astype(np.float32);records=[]
    colors=[(255,91,79),(30,180,236),(105,213,132),(200,131,246),(243,200,63)]
    for index,(raw_mask,box,score) in enumerate(zip(masks,boxes,scores)):
      mask=np.squeeze(raw_mask).astype(bool)
      if mask.shape!=(h,w):raise RuntimeError('SAM3 返回 mask 尺寸与原图不一致')
      if not np.isfinite(box).all() or not np.isfinite(score):raise RuntimeError('SAM3 返回非有限 boxes/scores')
      if not mask.any():continue
      mask_path=output/f'mask-{index:03d}.png';Image.fromarray(mask.astype(np.uint8)*255).save(mask_path)
      overlay[mask]=.55*overlay[mask]+.45*np.array(colors[index%len(colors)])
      records.append({'id':f"{request['requestId']}-mask-{index}",'uri':mask_path.as_uri(),'mimeType':'image/png','boxXYXY':[float(x) for x in box],'score':float(score),'pixelCount':int(mask.sum()),**({'label':request['textPrompt']} if request.get('textPrompt') else {})})
    overlay_image=Image.fromarray(np.clip(overlay,0,255).astype(np.uint8));draw=ImageDraw.Draw(overlay_image)
    for index,record in enumerate(records):draw.rectangle(record['boxXYXY'],outline=colors[index%len(colors)],width=2)
    overlay_image.save(output/'overlay.png')
    result={'provider':'sam3','requestId':request['requestId'],'source':source,'sourceModel':{'repository':'https://github.com/facebookresearch/sam3','commit':'660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7','checkpoint':str(checkpoint)},'image':{'uri':(output/'source.png').as_uri(),'width':w,'height':h,'mimeType':'image/png'},'overlay':{'uri':(output/'overlay.png').as_uri(),'mimeType':'image/png'},'masks':records,'emptyResult':not records,'inferenceSeconds':elapsed}
    (output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));return result

if __name__=='__main__':
    try:print('LYAPUNOV_RESULT='+json.dumps(predict(json.load(sys.stdin)),ensure_ascii=False,allow_nan=False))
    except (ProviderUnavailable,ImportError) as error:print('LYAPUNOV_RESULT='+json.dumps({'error':'PROVIDER_UNAVAILABLE','message':str(error)},ensure_ascii=False));sys.exit(2)
    except Exception as error:print('LYAPUNOV_RESULT='+json.dumps({'error':type(error).__name__,'message':str(error)},ensure_ascii=False));sys.exit(1)
