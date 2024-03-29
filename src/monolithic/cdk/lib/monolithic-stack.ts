import { RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export class MonolithicStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // vpc
    const vpc = new ec2.Vpc(this, 'BookStoreVpc', {
      vpcName: 'bookstore-vpc',
      ipAddresses: ec2.IpAddresses.cidr('172.16.0.0/16'),
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        }
      ],
      // remove all rules from default security group
      // See: https://docs.aws.amazon.com/config/latest/developerguide/vpc-default-security-group-closed.html
      restrictDefaultSecurityGroup: true,
    });

    // NOTE: Optimize networking costs by using gateway endpoints that are not billed for traffic.
    // See:  https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    //
    // security group
    //
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      allowAllOutbound: true,
      description: 'security group for alb'
    })
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'allow http traffic from anywhere')

    const ec2Sg = new ec2.SecurityGroup(this, 'AppEc2Sg', {
      vpc,
      allowAllOutbound: true,
      description: 'security group for application servers'
    })
    ec2Sg.connections.allowFrom(albSg, ec2.Port.tcp(80), 'allow http traffic from alb')

    //
    // role
    //
    const ec2Role = new iam.Role(this, 'AppRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore'
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonS3ReadOnlyAccess'
        ),
      ],
      description: 'role for application servers',
    });

    //
    // S3
    //
    const assetsDir = './assets';

    // s3 bucket for assets
    const assetBucket = new s3.Bucket(this, 'AssetBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // upload app
    const appVer = 'v1.0';
    const appKey = `app/${appVer}`;
    const appDeploy = new s3deploy.BucketDeployment(this, 'DeployApp', {
      sources: [s3deploy.Source.asset(assetsDir + `/${appKey}`)],
      destinationBucket: assetBucket,
      destinationKeyPrefix: appKey,
    });

    // upload nginx config
    const nginxDeploy = new s3deploy.BucketDeployment(this, 'DeployNginx', {
      sources: [s3deploy.Source.asset(assetsDir + '/nginx')],
      destinationBucket: assetBucket,
      destinationKeyPrefix: 'nginx',
    });
    // upload service config
    const serviceDeploy = new s3deploy.BucketDeployment(this, 'DeployService', {
      sources: [s3deploy.Source.asset(assetsDir + '/service')],
      destinationBucket: assetBucket,
      destinationKeyPrefix: 'service',
    });

    //
    // application server
    //
    // NOTE: The cloud-init output log file captures console output by user data. See: /var/log/cloud-init-output.log
    const userData = ec2.UserData.forLinux({
      shebang: '#!/bin/bash',
    })
    // setup nginx
    userData.addCommands(
      'dnf update -y',
      'dnf install nginx -y',
      'systemctl start nginx',
      'systemctl enable nginx',
    )
    // configure nginx as reverse proxy
    userData.addCommands(
      `aws s3 cp s3://${nginxDeploy.deployedBucket.bucketName}/nginx/bookstore.conf /etc/nginx/conf.d/bookstore.conf`,
      'nginx -s reload',
    )
    // setup mysql client
    userData.addCommands(
      // See: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ConnectToInstance.html
      'dnf install mariadb105 -y',
    );

    // setup globalization
    userData.addCommands(
      'dnf install icu -y',
    )
    // setup asp.net core runtime
    // NOTE: Installing aspnetcore-runtime-7.0 using dnf is not possible on Amazon Linux 2023.
    // See: https://learn.microsoft.com/en-us/dotnet/core/install/linux-scripted-manual#manual-install
    userData.addCommands(
      'DOWNLOAD_URL=https://download.visualstudio.microsoft.com/download/pr/b936641a-57d6-4069-bd32-280020863326/5793e00ff9e9973a01ca735479ff15b3/aspnetcore-runtime-7.0.5-linux-x64.tar.gz',
      'DOTNET_FILE=./aspnetcore-runtime.tar.gz',
      "wget $DOWNLOAD_URL -O $DOTNET_FILE",
      'export DOTNET_ROOT=/bin/dotnet',
      "mkdir -p $DOTNET_ROOT && tar zxf $DOTNET_FILE -C $DOTNET_ROOT",
      'echo "export PATH=\$PATH:$DOTNET_ROOT" >> /etc/environment',
      "rm $DOTNET_FILE"
    )
    // setup app
    userData.addCommands(
      'APP_DIR=/var/www/bookstore',
      'mkdir -p $APP_DIR',
      `aws s3 cp s3://${appDeploy.deployedBucket.bucketName}/${appKey} $APP_DIR --recursive`
    )
    // configure app as service
    userData.addCommands(
      `aws s3 cp s3://${serviceDeploy.deployedBucket.bucketName}/service/kestrel-bookstore.service /etc/systemd/system/kestrel-bookstore.service`,
      'systemctl enable kestrel-bookstore.service',
      'systemctl start kestrel-bookstore.service',
      'systemctl status kestrel-bookstore.service',
    )

    const launchTmpl = new ec2.LaunchTemplate(this, 'AppLaunchTmpl', {
      launchTemplateName: 'app-launch-tmpl',
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cachedInContext: true,
      }),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: autoscaling.BlockDeviceVolume.ebs(8, {
            encrypted: true
          }),
        },
      ],
      securityGroup: ec2Sg,
      role: ec2Role,
      userData,
    });

    const asGrpWeb = new autoscaling.AutoScalingGroup(this, 'AppAutoScalingGrp', {
      launchTemplate: launchTmpl,
      vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      desiredCapacity: 1,
      minCapacity: 1,
      maxCapacity: 3,
    })
    asGrpWeb.scaleOnCpuUtilization('Cpu50Percent', {
      targetUtilizationPercent: 50
    });

    //
    // alb
    //
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      internetFacing: true,
      vpc,
      vpcSubnets: {
        subnets: vpc.publicSubnets
      },
      securityGroup: albSg
    })

    const listener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP
    })
    listener.addTargets('AppTarget', {
      targets: [asGrpWeb],
      port: 80
    })

    new CfnOutput(this, 'AlbTestCommand', {
      value: `curl -I http://${alb.loadBalancerDnsName}`
    })

    //
    // rds
    //
    const engine = rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_31 });
    const paramGrp = new rds.ParameterGroup(this, 'BookStoreParamGrp', {
      engine,
      description: 'for bookstore'
    })
    const optGrp = new rds.OptionGroup(this, 'BookStoreOptGrp', {
      engine,
      configurations: [],
      description: 'for bookstore'
    })

    const databaseName = 'bookstore'
    const dbInstance = new rds.DatabaseInstance(this, 'BookStoreDbInstance', {
      engine,
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL),
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      databaseName,
      parameterGroup: paramGrp,
      optionGroup: optGrp,
      multiAz: true,
      deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.DESTROY    // to avoid OptionGroup deletion error, do not leave any snapshots
    });
    dbInstance.connections.allowDefaultPortFrom(ec2Sg);

    new CfnOutput(this, 'RdsConnectionCommand', {
      value: `mysql -h ${dbInstance.instanceEndpoint.hostname} -D ${databaseName} -P ${dbInstance.dbInstanceEndpointPort} -u admin -p`
    });

    new CfnOutput(this, 'RdsConnectionString', {
      value: `server=${dbInstance.instanceEndpoint.hostname};Port=${dbInstance.dbInstanceEndpointPort};database=${databaseName};user=admin;password=<replace with your password>`
    });
  }
}
